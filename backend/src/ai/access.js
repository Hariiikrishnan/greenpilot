// Green Pilot AI tenant access (Phase 9).
//
// Agents are org-owned (agents.organization_id, backfilled in 064). Reads use
// dual-read (org match OR legacy NULL); writes adopt legacy NULL rows into
// the acting org. Invisible agents read as 404 (never 403) so ids cannot be
// probed across tenants — same rule as the scope-layer assertOrgRow.

async function getAgentRow(db, agentId) {
  const { rows } = await db.query(
    `SELECT a.*, am.provider AS ai_provider, am.api_key_encrypted AS ai_api_key_encrypted
       FROM coexistence.agents a
       LEFT JOIN coexistence.ai_models am ON am.id = a.ai_model_id
      WHERE a.id = $1`,
    [agentId]
  );
  return rows[0] || null;
}

// Carries an HTTP status (and optional machine code) for route/worker error
// mapping (client-visible message stays safe).
class AiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

// Returns the agent row when `req`'s org may use it, else null.
// - req.org present: agent.organization_id == org OR NULL (legacy dual-read).
// - req.org absent (legacy single-owner): only NULL-org agents.
function agentVisibleToOrg(agent, orgId) {
  if (!agent) return false;
  if (!orgId) return agent.organization_id == null;
  return agent.organization_id == null || String(agent.organization_id) === String(orgId);
}

async function assertAgentAccess(db, req, agentId) {
  const agent = await getAgentRow(db, agentId);
  if (!agent || !agentVisibleToOrg(agent, req?.org?.id || null)) return null;
  return agent;
}

// Adopt a legacy (NULL-org) agent into the acting org on first management
// write. Returns true when an adoption write happened.
async function adoptAgentOrg(db, agent, orgId) {
  if (!orgId || agent.organization_id != null) return false;
  await db.query(
    `UPDATE coexistence.agents SET organization_id = $1, updated_at = NOW()
      WHERE id = $2 AND organization_id IS NULL`,
    [orgId, agent.id]
  );
  return true;
}

module.exports = { AiError, getAgentRow, agentVisibleToOrg, assertAgentAccess, adoptAgentOrg };
