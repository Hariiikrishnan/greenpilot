// Human handoff for AI agents.
//
// The "controller" of a conversation is either the bot or a human. Handoff
// flips it to a human: round-robin a BDA from the agent's eligible pool, assign
// the contact, notify, and set contacts.agent_paused so routeIfActive() stops
// running the agent. resumeAgent() flips it back (manual "Return to bot").

const pool = require('../db');
const bus = require('../events');

function emit(event, payload) { try { bus.emit(event, payload); } catch { /* best-effort SSE */ } }

// Pick the next eligible BDA round-robin (advancing the agent's cursor
// atomically), assign + pause the conversation. `by` = 'agent' | 'keyword' |
// 'manual:<userId>'. Returns { assignedUserId, assignedUserName }.
// `organizationId` (when known) tenant-binds every write (strict scope —
// mirrors scope.js assertOrgRow); assignees must be members of that org.
async function performHandoff({ agentId, handoffUserIds, waNumber, contactNumber, organizationId, reason, by, assignTo }) {
  const org = organizationId || null;
  const SCOPE = 'AND (($6::uuid IS NULL AND organization_id IS NULL) OR organization_id = $6)';
  let assignedUserId = assignTo != null ? parseInt(assignTo, 10) || null : null;
  let assignedUserName = null;

  // Round-robin choose a BDA (unless a specific assignee was given, e.g. a
  // human clicking "take over" assigns it to themselves).
  if (!assignedUserId) {
    const ids = (Array.isArray(handoffUserIds) ? handoffUserIds : []).map(n => parseInt(n, 10)).filter(Boolean);
    if (ids.length > 0) {
      const { rows } = await pool.query(
        `UPDATE coexistence.agents
            SET handoff_rr_pointer = (COALESCE(handoff_rr_pointer, -1) + 1) % $2
          WHERE id = $1
        RETURNING handoff_rr_pointer`,
        [agentId, ids.length],
      );
      const idx = rows[0] ? ((rows[0].handoff_rr_pointer % ids.length) + ids.length) % ids.length : 0;
      assignedUserId = ids[idx];
    }
  }

  if (assignedUserId) {
    // Assignees must be active members of the handoff org (when known) — a
    // forged user id from another tenant can never receive the conversation.
    const { rows: ur } = org
      ? await pool.query(
          `SELECT u.id, COALESCE(u.display_name, u.username) AS name
             FROM coexistence.forgecrm_users u
             JOIN coexistence.organization_members m
               ON m.user_id = u.id AND m.organization_id = $2
            WHERE u.id = $1 AND u.is_active = TRUE`,
          [assignedUserId, org],
        )
      : await pool.query(
          `SELECT id, COALESCE(display_name, username) AS name FROM coexistence.forgecrm_users WHERE id = $1 AND is_active = TRUE`,
          [assignedUserId],
        );
    if (ur[0]) assignedUserName = ur[0].name; else assignedUserId = null; // skip a deactivated/foreign BDA
  }

  const { rowCount } = await pool.query(
    `UPDATE coexistence.contacts
        SET agent_paused = TRUE, agent_paused_at = NOW(),
            agent_paused_reason = $3, agent_paused_by = $4,
            assigned_user_id = COALESCE($5, assigned_user_id), updated_at = NOW()
      WHERE wa_number = $1 AND contact_number = $2 ${SCOPE}`,
    [waNumber, contactNumber, (reason || '').slice(0, 500) || null, by || 'agent', assignedUserId, org],
  );
  if (rowCount === 0) throw new Error('Contact not found in this organization');

  emit('contact-saved', { waNumber, contactNumber });
  if (assignedUserId) emit('contact-assignment-changed', { waNumber, contactNumber, assignedUserId });
  emit('agent-handoff', { waNumber, contactNumber, assignedUserId, assignedUserName, reason, by });
  return { assignedUserId, assignedUserName };
}

// Manual "Return to bot" — clear the pause so the agent answers again.
async function resumeAgent({ waNumber, contactNumber, by, organizationId }) {
  const org = organizationId || null;
  const { rowCount } = await pool.query(
    `UPDATE coexistence.contacts
        SET agent_paused = FALSE, agent_paused_at = NULL, agent_paused_reason = NULL, agent_paused_by = NULL, updated_at = NOW()
      WHERE wa_number = $1 AND contact_number = $2
        AND (($3::uuid IS NULL AND organization_id IS NULL) OR organization_id = $3)`,
    [waNumber, contactNumber, org],
  );
  if (rowCount === 0) throw new Error('Contact not found in this organization');
  emit('agent-resumed', { waNumber, contactNumber, by });
  return { ok: true };
}

async function isConversationPaused(waNumber, contactNumber, organizationId) {
  const org = organizationId || null;
  const { rows } = await pool.query(
    `SELECT agent_paused FROM coexistence.contacts
      WHERE wa_number = $1 AND contact_number = $2
        AND (($3::uuid IS NULL AND organization_id IS NULL) OR organization_id = $3)`,
    [waNumber, contactNumber, org],
  );
  return !!rows[0]?.agent_paused;
}

// comma-separated keywords → does the message contain any? (case-insensitive)
function matchesAnyHandoffKeyword(messageBody, keywords) {
  if (!messageBody || !keywords) return false;
  const msg = String(messageBody).toLowerCase();
  return String(keywords).split(',').map(k => k.trim().toLowerCase()).filter(Boolean).some(k => msg.includes(k));
}

module.exports = { performHandoff, resumeAgent, isConversationPaused, matchesAnyHandoffKeyword };
