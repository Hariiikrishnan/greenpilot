// Green Pilot canonical CRM service (Phase 11).
//
// Canonical model: Lead ≡ contact (composite (wa_number, contact_number)
// identity, org-owned). No parallel leads table — every subsystem already
// keys on the contact pair. This module owns lead reads/writes, status/
// stage/assignment transitions (each: validate tenant → update atomically →
// activity → socket + automation-bus events), notes/calls/follow-ups CRUD,
// and the merged activity timeline.
//
// All functions take an explicit `db` (pool). Multi-statement transitions
// use row locks (SELECT … FOR UPDATE) so concurrent operators produce a
// consistent final state.

const LEAD_STATUSES = [
  'new',
  'contacted',
  'qualified',
  'unqualified',
  'needs-more-information',
  'won',
  'lost',
];

class CrmError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'CrmError';
    this.status = status;
    if (code !== undefined) this.code = code;
    /** @type {any} */
    this.details = undefined;
  }
}

function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

// Strict lead scope (mirrors scope.js assertOrgRow): org callers touch only
// their org rows; legacy callers only legacy rows.
/**
 * @param {string} alias
 * @param {string|null} orgId
 * @param {number} nextParam
 */
function leadScope(alias, orgId, nextParam) {
  if (orgId) return { clause: `AND ${alias}.organization_id = $${nextParam}`, params: [orgId] };
  return { clause: `AND ${alias}.organization_id IS NULL`, params: [] };
}

async function getLeadById(db, orgId, id) {
  const scope = leadScope('c', orgId, 2);
  const { rows } = await db.query(
    `SELECT c.* FROM coexistence.contacts c WHERE c.id = $1 ${scope.clause} LIMIT 1`,
    [id, ...scope.params]
  );
  return rows[0] || null;
}

async function getLeadByContact(db, orgId, waNumber, contactNumber) {
  const scope = leadScope('c', orgId, 3);
  const { rows } = await db.query(
    `SELECT c.* FROM coexistence.contacts c
      WHERE c.wa_number = $1 AND c.contact_number = $2 ${scope.clause} LIMIT 1`,
    [waNumber, contactNumber, ...scope.params]
  );
  return rows[0] || null;
}

function leadShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    waNumber: row.wa_number,
    contactNumber: row.contact_number,
    name: row.name,
    profileName: row.profile_name,
    tags: Array.isArray(row.tags) ? row.tags : [],
    customFields: row.custom_fields && typeof row.custom_fields === 'object' ? row.custom_fields : {},
    assignedUserId: row.assigned_user_id,
    leadStatus: row.lead_status || 'new',
    pipelineStageId: row.pipeline_stage_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Enrichment: latest qualification + open follow-up count (both org-scoped).
async function enrichLead(db, orgId, lead) {
  const out = { ...lead, qualification: null, openFollowups: 0 };
  if (!lead) return out;
  const scopeQ = orgId ? 'AND organization_id = $3' : 'AND organization_id IS NULL';
  const scopeP = orgId ? [lead.waNumber, lead.contactNumber, orgId] : [lead.waNumber, lead.contactNumber];
  const { rows: q } = await db.query(
    `SELECT status, score, intent, summary, evaluated_at
       FROM coexistence.lead_qualifications
      WHERE wa_number = $1 AND contact_number = $2 ${scopeQ}
      ORDER BY evaluated_at DESC LIMIT 1`,
    scopeP
  );
  if (q[0]) {
    out.qualification = {
      status: q[0].status, score: q[0].score, intent: q[0].intent,
      summary: q[0].summary, evaluatedAt: q[0].evaluated_at,
    };
  }
  const scopeF = orgId ? 'AND organization_id = $2' : 'AND organization_id IS NULL';
  const paramsF = orgId ? [lead.contactNumber, orgId] : [lead.contactNumber];
  const { rows: f } = await db.query(
    `SELECT COUNT(*)::int AS n FROM coexistence.follow_ups
      WHERE contact_ref = $1 AND status = 'pending' ${scopeF}`,
    paramsF
  );
  out.openFollowups = f[0]?.n || 0;
  return out;
}

/**
 * @param {{query: Function}} db
 * @param {string|null} orgId
 * @param {{search?: string, status?: string, stageId?: string|number,
 *   assignedUserId?: string|number, qualification?: string,
 *   page?: string|number, limit?: string|number}} [filters]
 */
async function listLeads(db, orgId, {
  search, status, stageId, assignedUserId, qualification, page = 1, limit = 20,
} = {}) {
  const limitN = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
  const pageN = Math.max(1, parseInt(String(page), 10) || 1);
  const offset = (pageN - 1) * limitN;
  const scope = leadScope('c', orgId, 1);
  const where = [scope.clause];
  /** @type {any[]} */
  const params = [...scope.params];
  /** @param {any} v */
  const addParam = (v) => { params.push(v); return `$${params.length}`; };

  if (search) {
    const like = `%${String(search).trim().slice(0, 100)}%`;
    const p = addParam(like);
    // (wa_number, contact_number) are globally unique per pair, but names are
    // user-controlled — ILIKE on bounded input only.
    where.push(`AND (c.contact_number ILIKE ${p} OR COALESCE(c.name,'') ILIKE ${p} OR COALESCE(c.profile_name,'') ILIKE ${p})`);
  }
  if (status) {
    if (status === 'new') where.push(`AND (c.lead_status IS NULL OR c.lead_status = 'new')`);
    else {
      if (!LEAD_STATUSES.includes(status)) throw new CrmError(`Unknown status "${status}"`, 400, 'unknown-status');
      where.push(`AND c.lead_status = ${addParam(status)}`);
    }
  }
  if (stageId) where.push(`AND c.pipeline_stage_id = ${addParam(stageId)}`);
  if (assignedUserId === 'unassigned') where.push(`AND c.assigned_user_id IS NULL`);
  else if (assignedUserId) where.push(`AND c.assigned_user_id = ${addParam(assignedUserId)}`);
  if (qualification) {
    const qScope = orgId ? 'AND q.organization_id = c.organization_id' : 'AND q.organization_id IS NULL';
    where.push(`AND EXISTS (SELECT 1 FROM coexistence.lead_qualifications q
      WHERE q.wa_number = c.wa_number AND q.contact_number = c.contact_number ${qScope}
      ORDER BY q.evaluated_at DESC LIMIT 1 OFFSET 0)
      AND (SELECT q2.status FROM coexistence.lead_qualifications q2
        WHERE q2.wa_number = c.wa_number AND q2.contact_number = c.contact_number ${qScope.replace(/q\./g, 'q2.')}
        ORDER BY q2.evaluated_at DESC LIMIT 1) = ${addParam(qualification)}`);
  }

  const whereSql = where.join(' ');
  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM coexistence.contacts c WHERE TRUE ${whereSql}`, params
  );
  const total = countRows[0].n;
  const { rows } = await db.query(
    `SELECT c.* FROM coexistence.contacts c WHERE TRUE ${whereSql}
      ORDER BY c.updated_at DESC, c.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limitN, offset]
  );
  const data = [];
  for (const row of rows) {
    data.push(await enrichLead(db, orgId, leadShape(row)));
  }
  return { data, total, page: pageN, totalPages: Math.ceil(total / limitN) };
}

async function requireMember(db, orgId, userId) {
  if (!orgId) return { id: userId };
  const { rows } = await db.query(
    `SELECT u.id, u.display_name, u.username, u.is_active
       FROM coexistence.forgecrm_users u
       JOIN coexistence.organization_members m ON m.user_id = u.id AND m.organization_id = $2
      WHERE u.id = $1`,
    [userId, orgId]
  );
  const u = rows[0];
  if (!u || u.is_active === false) {
    throw new CrmError('Assignee must be an active member of this organization', 400, 'foreign-assignee');
  }
  return u;
}

async function addActivity(db, orgId, waNumber, contactNumber, kind, summary, actorUserId) {
  await db.query(
    `INSERT INTO coexistence.lead_activities
       (organization_id, wa_number, contact_number, kind, summary, actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [orgId, waNumber, contactNumber, kind, summary ? String(summary).slice(0, 2000) : null, actorUserId || null]
  );
  try {
    require('../realtime/emitter').emitCrmEvent(orgId, 'activity-created', {
      waNumber, contactNumber, kind,
    });
  } catch (err) {
    console.error('[crm] activity realtime emit failed:', err.message);
  }
}

function emitLeadSocket(orgId, name, lead) {
  try {
    require('../realtime/emitter').emitCrmEvent(orgId, name, lead);
  } catch (err) {
    console.error('[crm] realtime emit failed:', err.message);
  }
}

async function emitStatusBus(db, { orgId, waNumber, contactNumber, status, previous, depth = 0, visited = [] }) {
  try {
    const autoService = require('../automation/service');
    await autoService.emitAutomationEvent(db, {
      organizationId: orgId,
      eventType: 'lead.status.changed',
      entityId: `${waNumber}:${contactNumber}:${status}`,
      eventId: `leadstatus:${orgId}:${waNumber}:${contactNumber}:${status}`,
      payload: { wa_number: waNumber, contact_number: contactNumber, status, previous_status: previous || null },
      depth, visited,
    });
  } catch (err) {
    console.error('[crm] status bus emit failed:', err.message);
  }
}

async function createLead(pool, orgId, { waNumber, contactNumber, name, assignedUserId }, actorUserId) {
  const wa = digits(waNumber);
  const contact = digits(contactNumber);
  if (!wa || !contact) throw new CrmError('waNumber and contactNumber are required', 400);
  let assignee = null;
  if (assignedUserId != null && assignedUserId !== '') {
    assignee = await requireMember(pool, orgId, assignedUserId);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scope = leadScope('c', orgId, 3);
    const { rows: dup } = await client.query(
      `SELECT id FROM coexistence.contacts c WHERE c.wa_number = $1 AND c.contact_number = $2 ${scope.clause} LIMIT 1`,
      [wa, contact, ...scope.params]
    );
    if (dup[0]) {
      const err = new CrmError('Lead already exists', 409, 'lead-exists');
      err.details = { leadId: dup[0].id };
      throw err;
    }
    const { rows } = await client.query(
      `INSERT INTO coexistence.contacts
         (wa_number, contact_number, organization_id, name, assigned_user_id, lead_status)
       VALUES ($1,$2,$3,$4,$5,'new')
       RETURNING *`,
      [wa, contact, orgId || null, (name || '').trim().slice(0, 255) || null, assignee ? assignee.id : null]
    );
    await client.query(
      `INSERT INTO coexistence.lead_activities
         (organization_id, wa_number, contact_number, kind, summary, actor_user_id)
       VALUES ($1,$2,$3,'created',$4,$5)`,
      [orgId, wa, contact, `Lead created${assignee ? `, assigned to ${assignee.display_name || assignee.username}` : ''}`, actorUserId || null]
    );
    await client.query('COMMIT');
    const lead = leadShape(rows[0]);
    emitLeadSocket(orgId, 'lead-created', { ...lead, leadId: lead.id });
    // Automation: first-class lead.created (idempotent with the webhook's —
    // same deterministic eventId collapses duplicates).
    try {
      const autoService = require('../automation/service');
      await autoService.emitAutomationEvent(pool, {
        organizationId: orgId,
        eventType: 'lead.created',
        entityId: `${wa}:${contact}`,
        eventId: autoService.leadCreatedEventId(orgId, wa, contact),
        payload: { wa_number: wa, contact_number: contact, message_body: null },
      });
    } catch (err) {
      console.error('[crm] lead.created bus emit failed:', err.message);
    }
    return lead;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function deleteLead(pool, orgId, id) {
  const { rowCount } = orgId
    ? await pool.query(
        `DELETE FROM coexistence.contacts WHERE id = $1 AND organization_id = $2`,
        [id, orgId]
      )
    : await pool.query(
        `DELETE FROM coexistence.contacts WHERE id = $1 AND organization_id IS NULL`,
        [id]
      );
  return rowCount > 0;
}

// Lock-modify-emit helper for status/stage/assign transitions (the actor id
// is captured by each mutate closure for its activity row).
async function transitionLead(pool, orgId, id, mutate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scope = leadScope('c', orgId, 2);
    const { rows } = await client.query(
      `SELECT c.* FROM coexistence.contacts c WHERE c.id = $1 ${scope.clause} LIMIT 1 FOR UPDATE`,
      [id, ...scope.params]
    );
    if (!rows[0]) {
      const err = new CrmError('Lead not found', 404, 'lead-not-found');
      throw err;
    }
    const result = await mutate(client, rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function setLeadStatus(pool, orgId, id, status, actorUserId) {
  if (!LEAD_STATUSES.includes(status)) {
    throw new CrmError(`Unknown status "${status}". Valid: ${LEAD_STATUSES.join(', ')}`, 400, 'unknown-status');
  }
  return transitionLead(pool, orgId, id, async (client, row) => {
    const previous = row.lead_status || 'new';
    if (previous === status) return { lead: leadShape(row), changed: false };
    await client.query(
      `UPDATE coexistence.contacts SET lead_status = $1, updated_at = NOW() WHERE id = $2`,
      [status, id]
    );
    await client.query(
      `INSERT INTO coexistence.lead_activities
         (organization_id, wa_number, contact_number, kind, summary, actor_user_id)
       VALUES ($1,$2,$3,'status',$4,$5)`,
      [orgId, row.wa_number, row.contact_number, `Status: ${previous} → ${status}`, actorUserId || null]
    );
    const lead = leadShape({ ...row, lead_status: status });
    emitLeadSocket(orgId, 'lead-status-changed', { ...lead, leadId: lead.id });
    await emitStatusBus(pool, {
      orgId, waNumber: row.wa_number, contactNumber: row.contact_number, status, previous,
    });
    return { lead, changed: true, previous };
  });
}

async function setLeadStage(pool, orgId, id, stageId, actorUserId) {
  return transitionLead(pool, orgId, id, async (client, row) => {
    let stage = null;
    if (stageId != null && stageId !== '') {
      const { rows: sRows } = await client.query(
        `SELECT s.id, s.name, s.pipeline_id, p.organization_id AS pipeline_org
           FROM coexistence.pipeline_stages s
           JOIN coexistence.pipelines p ON p.id = s.pipeline_id
          WHERE s.id = $1`,
        [stageId]
      );
      stage = sRows[0] || null;
      // Stage, its pipeline, and the lead must all belong to this org.
      if (!stage || (orgId && String(stage.pipeline_org) !== String(orgId))) {
        throw new CrmError('Stage not found in this organization', 404, 'stage-not-found');
      }
    }
    const previous = row.pipeline_stage_id;
    if (String(previous || '') === String(stage ? stage.id : '')) {
      return { lead: leadShape(row), changed: false };
    }
    await client.query(
      `UPDATE coexistence.contacts SET pipeline_stage_id = $1, updated_at = NOW() WHERE id = $2`,
      [stage ? stage.id : null, id]
    );
    await client.query(
      `INSERT INTO coexistence.lead_activities
         (organization_id, wa_number, contact_number, kind, summary, actor_user_id)
       VALUES ($1,$2,$3,'stage',$4,$5)`,
      [orgId, row.wa_number, row.contact_number,
        stage ? `Moved to stage "${stage.name}"` : 'Removed from pipeline stage', actorUserId || null]
    );
    const lead = leadShape({ ...row, pipeline_stage_id: stage ? stage.id : null });
    emitLeadSocket(orgId, 'lead-updated', { ...lead, leadId: lead.id });
    // Stage moves are status-relevant: feed the existing automation trigger
    // (deterministic id — re-setting the same stage is a no-op downstream).
    try {
      const autoService = require('../automation/service');
      await autoService.emitAutomationEvent(pool, {
        organizationId: orgId,
        eventType: 'lead.status.changed',
        entityId: `${row.wa_number}:${row.contact_number}:stage:${stage ? stage.id : 'none'}`,
        eventId: `leadstage:${orgId}:${row.wa_number}:${row.contact_number}:${stage ? stage.id : 'none'}`,
        payload: {
          wa_number: row.wa_number, contact_number: row.contact_number,
          stage_id: stage ? stage.id : null, stage_name: stage ? stage.name : null,
        },
      });
    } catch (err) {
      console.error('[crm] stage bus emit failed:', err.message);
    }
    return { lead, changed: true };
  });
}

async function assignLead(pool, orgId, id, userId, actorUserId) {
  // Resolve the lead first (invisible → 404) so assignee validation can
  // never leak or override lead visibility.
  const visible = await getLeadById(pool, orgId, id);
  if (!visible) throw new CrmError('Lead not found', 404, 'lead-not-found');
  let assignee = null;
  if (userId != null && userId !== '') {
    assignee = await requireMember(pool, orgId, userId);
  }
  return transitionLead(pool, orgId, id, async (client, row) => {
    const previous = row.assigned_user_id;
    if (String(previous || '') === String(assignee ? assignee.id : '')) {
      return { lead: leadShape(row), changed: false };
    }
    await client.query(
      `UPDATE coexistence.contacts SET assigned_user_id = $1, updated_at = NOW() WHERE id = $2`,
      [assignee ? assignee.id : null, id]
    );
    await client.query(
      `INSERT INTO coexistence.lead_activities
         (organization_id, wa_number, contact_number, kind, summary, actor_user_id)
       VALUES ($1,$2,$3,'assigned',$4,$5)`,
      [orgId, row.wa_number, row.contact_number,
        assignee ? `Assigned to ${assignee.display_name || assignee.username}` : 'Unassigned', actorUserId || null]
    );
    const lead = leadShape({ ...row, assigned_user_id: assignee ? assignee.id : null });
    emitLeadSocket(orgId, 'lead-assigned', { ...lead, leadId: lead.id });
    return { lead, changed: true };
  });
}

// --- Notes ------------------------------------------------------------------------

async function resolveLeadOrg(pool, orgId, waNumber, contactNumber) {
  const lead = await getLeadByContact(pool, orgId, waNumber, contactNumber);
  if (!lead) throw new CrmError('Lead not found', 404, 'lead-not-found');
  return lead;
}

async function listNotes(db, orgId, contactNumber) {
  const scope = orgId ? 'AND organization_id = $2' : 'AND organization_id IS NULL';
  const params = orgId ? [contactNumber, orgId] : [contactNumber];
  const { rows } = await db.query(
    `SELECT n.id, n.contact_ref, n.body, n.created_by, u.display_name AS author_name, n.created_at
       FROM coexistence.lead_notes n
       LEFT JOIN coexistence.forgecrm_users u ON u.id = n.created_by
      WHERE n.contact_ref = $1 ${scope}
      ORDER BY n.created_at DESC LIMIT 50`,
    params
  );
  return rows;
}

async function createNote(pool, orgId, waNumber, contactNumber, body, actorUserId) {
  const clean = String(body || '').trim().slice(0, 2000);
  if (!clean) throw new CrmError('Note text is required', 400);
  const lead = await resolveLeadOrg(pool, orgId, waNumber, contactNumber);
  const { rows } = await pool.query(
    `INSERT INTO coexistence.lead_notes (organization_id, contact_ref, body, created_by)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [orgId, lead.contact_number, clean, actorUserId || null]
  );
  emitLeadSocket(orgId, 'activity-created', { ...leadShape(lead), leadId: lead.id, kind: 'note' });
  return rows[0];
}

async function updateNote(pool, orgId, noteId, body) {
  const clean = String(body || '').trim().slice(0, 2000);
  if (!clean) throw new CrmError('Note text is required', 400);
  const { rows } = orgId
    ? await pool.query(
        `UPDATE coexistence.lead_notes SET body = $3 WHERE id = $1 AND organization_id = $2 RETURNING *`,
        [noteId, orgId, clean]
      )
    : await pool.query(
        `UPDATE coexistence.lead_notes SET body = $2 WHERE id = $1 AND organization_id IS NULL RETURNING *`,
        [noteId, clean]
      );
  if (!rows[0]) throw new CrmError('Note not found', 404, 'note-not-found');
  return rows[0];
}

async function deleteNote(pool, orgId, noteId) {
  const scope = orgId ? 'AND organization_id = $2' : 'AND organization_id IS NULL';
  const params = orgId ? [noteId, orgId] : [noteId];
  const { rowCount } = await pool.query(
    `DELETE FROM coexistence.lead_notes WHERE id = $1 ${scope}`, params
  );
  return rowCount > 0;
}

// --- Calls --------------------------------------------------------------------------

async function listCalls(db, orgId, contactNumber) {
  const scope = orgId ? 'AND organization_id = $2' : 'AND organization_id IS NULL';
  const params = orgId ? [contactNumber, orgId] : [contactNumber];
  const { rows } = await db.query(
    `SELECT c.id, c.contact_ref, c.outcome, c.notes, c.created_by, u.display_name AS author_name, c.created_at
       FROM coexistence.lead_calls c
       LEFT JOIN coexistence.forgecrm_users u ON u.id = c.created_by
      WHERE c.contact_ref = $1 ${scope}
      ORDER BY c.created_at DESC LIMIT 50`,
    params
  );
  return rows;
}

async function logCall(pool, orgId, waNumber, contactNumber, { outcome, notes }, actorUserId) {
  const lead = await resolveLeadOrg(pool, orgId, waNumber, contactNumber);
  const { rows } = await pool.query(
    `INSERT INTO coexistence.lead_calls (organization_id, contact_ref, outcome, notes, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [orgId, lead.contact_number,
      (outcome || '').trim().slice(0, 200) || null,
      (notes || '').trim().slice(0, 2000) || null,
      actorUserId || null]
  );
  emitLeadSocket(orgId, 'activity-created', { ...leadShape(lead), leadId: lead.id, kind: 'call' });
  return rows[0];
}

async function deleteCall(pool, orgId, callId) {
  const scope = orgId ? 'AND organization_id = $2' : 'AND organization_id IS NULL';
  const params = orgId ? [callId, orgId] : [callId];
  const { rowCount } = await pool.query(
    `DELETE FROM coexistence.lead_calls WHERE id = $1 ${scope}`, params
  );
  return rowCount > 0;
}

// --- Follow-ups -------------------------------------------------------------------------

/**
 * @param {{query: Function}} db
 * @param {string|null} orgId
 * @param {string} contactNumber
 * @param {{status?: string, page?: string|number, limit?: string|number}} [opts]
 */
async function listFollowups(db, orgId, contactNumber, { status, page = 1, limit = 20 } = {}) {
  const limitN = Math.min(50, Math.max(1, parseInt(String(limit), 10) || 20));
  const pageN = Math.max(1, parseInt(String(page), 10) || 1);
  const scope = orgId ? 'AND organization_id = $2' : 'AND organization_id IS NULL';
  const params = orgId ? [contactNumber, orgId] : [contactNumber];
  let extra = '';
  if (status) {
    if (!['pending', 'done', 'cancelled'].includes(status)) {
      throw new CrmError('Unknown follow-up status', 400, 'unknown-status');
    }
    extra = ` AND status = $${params.length + 1}`;
    params.push(status);
  }
  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM coexistence.follow_ups WHERE contact_ref = $1 ${scope}${extra}`,
    params
  );
  const { rows } = await db.query(
    `SELECT f.id, f.contact_ref, f.due_at, f.status, f.assigned_to,
            u.display_name AS assignee_name, f.created_at
       FROM coexistence.follow_ups f
       LEFT JOIN coexistence.forgecrm_users u ON u.id = f.assigned_to
      WHERE f.contact_ref = $1 ${scope.replace(/organization_id/g, 'f.organization_id')}${extra.replace(/status = /g, 'f.status = ')}
      ORDER BY f.due_at ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limitN, (pageN - 1) * limitN]
  );
  return { data: rows, total: countRows[0].n, page: pageN, totalPages: Math.ceil(countRows[0].n / limitN) };
}

function parseDueAt(spec) {
  const s = String(spec || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*([mhd])$/i);
  if (m) {
    const mult = { m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
    const t = Date.now() + parseInt(m[1], 10) * mult;
    return new Date(t);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function createFollowup(pool, orgId, waNumber, contactNumber, { dueAt, assignedTo }) {
  const lead = await resolveLeadOrg(pool, orgId, waNumber, contactNumber);
  const due = parseDueAt(dueAt);
  if (!due || due.getTime() <= Date.now()) {
    throw new CrmError('dueAt must be a future datetime (ISO or like 2h/3d)', 400, 'bad-due-date');
  }
  let assignee = null;
  if (assignedTo != null && assignedTo !== '') {
    assignee = await requireMember(pool, orgId, assignedTo);
  }
  const { rows } = await pool.query(
    `INSERT INTO coexistence.follow_ups (organization_id, contact_ref, due_at, status, assigned_to)
     VALUES ($1,$2,$3,'pending',$4) RETURNING *`,
    [orgId, lead.contact_number, due.toISOString(), assignee ? assignee.id : null]
  );
  emitLeadSocket(orgId, 'followup-created', { ...leadShape(lead), leadId: lead.id });
  return rows[0];
}

async function setFollowupStatus(pool, orgId, followupId, status) {
  if (!['done', 'cancelled'].includes(status)) {
    throw new CrmError('Follow-up can only transition to done or cancelled', 400, 'bad-transition');
  }
  const { rows } = orgId
    ? await pool.query(
        `UPDATE coexistence.follow_ups SET status = $3 WHERE id = $1 AND status = 'pending' AND organization_id = $2 RETURNING *`,
        [followupId, orgId, status]
      )
    : await pool.query(
        `UPDATE coexistence.follow_ups SET status = $2 WHERE id = $1 AND status = 'pending' AND organization_id IS NULL RETURNING *`,
        [followupId, status]
      );
  if (!rows[0]) throw new CrmError('Pending follow-up not found', 404, 'followup-not-found');
  emitLeadSocket(orgId, 'followup-completed', {
    waNumber: '', contactNumber: rows[0].contact_ref, leadId: null,
  });
  return rows[0];
}

// --- Timeline -------------------------------------------------------------------------------

// Merged, user-safe activity view. Unions the durable sources (each already
// org-scoped); sorts newest-first; slices to limit. Summaries only —
// qualification rows contribute status/score/summary, never reasoning.
/**
 * @param {{query: Function}} db
 * @param {string|null} orgId
 * @param {string} waNumber
 * @param {string} contactNumber
 * @param {{limit?: string|number}} [opts]
 */
async function getTimeline(db, orgId, waNumber, contactNumber, { limit = 30 } = {}) {
  const limitN = Math.min(50, Math.max(1, parseInt(String(limit), 10) || 30));
  // Parameterized org scope per query (orgId is server-derived, but bound
  // parameters keep every timeline source injection-clean by construction).
  const scoped = (alias, n) => (orgId
    ? { clause: `AND ${alias}.organization_id = $${n}`, params: [orgId] }
    : { clause: `AND ${alias}.organization_id IS NULL`, params: [] });
  const items = [];
  const push = (kind, ts, summary, ref) => {
    items.push({ kind, ts: ts ? new Date(ts).toISOString() : null, summary: summary || null, ref: ref || null });
  };

  let s = scoped('lead_activities', 3);
  const { rows: acts } = await db.query(
    `SELECT kind, summary, created_at FROM coexistence.lead_activities
      WHERE wa_number = $1 AND contact_number = $2 ${s.clause}
      ORDER BY created_at DESC LIMIT 50`,
    [waNumber, contactNumber, ...s.params]
  );
  for (const r of acts) push(r.kind === 'created' ? 'lead created' : r.kind, r.created_at, r.summary, null);

  s = scoped('lead_notes', 2);
  const { rows: notes } = await db.query(
    `SELECT body, created_at FROM coexistence.lead_notes
      WHERE contact_ref = $1 ${s.clause}
      ORDER BY created_at DESC LIMIT 20`,
    [contactNumber, ...s.params]
  );
  for (const r of notes) push('note added', r.created_at, String(r.body || '').slice(0, 280), null);

  s = scoped('lead_calls', 2);
  const { rows: calls } = await db.query(
    `SELECT outcome, notes, created_at FROM coexistence.lead_calls
      WHERE contact_ref = $1 ${s.clause}
      ORDER BY created_at DESC LIMIT 20`,
    [contactNumber, ...s.params]
  );
  for (const r of calls) {
    push('call logged', r.created_at, [r.outcome, r.notes].filter(Boolean).join(' — ').slice(0, 280) || 'Call logged', null);
  }

  s = scoped('follow_ups', 2);
  const { rows: fus } = await db.query(
    `SELECT id, due_at, status, created_at FROM coexistence.follow_ups
      WHERE contact_ref = $1 ${s.clause}
      ORDER BY created_at DESC LIMIT 20`,
    [contactNumber, ...s.params]
  );
  for (const r of fus) {
    push(r.status === 'pending' ? 'follow-up created' : `follow-up ${r.status}`, r.created_at,
      `Follow-up ${r.status}${r.status === 'pending' && r.due_at ? `, due ${new Date(r.due_at).toLocaleString()}` : ''}`, r.id);
  }

  s = scoped('lead_qualifications', 3);
  const { rows: quals } = await db.query(
    `SELECT status, score, summary, evaluated_at FROM coexistence.lead_qualifications
      WHERE wa_number = $1 AND contact_number = $2 ${s.clause}
      ORDER BY evaluated_at DESC LIMIT 10`,
    [waNumber, contactNumber, ...s.params]
  );
  for (const r of quals) {
    push('AI qualification', r.evaluated_at,
      `${r.status}${r.score != null ? ` (${r.score})` : ''}${r.summary ? ` — ${String(r.summary).slice(0, 200)}` : ''}`, null);
  }

  s = scoped('chat_history', 3);
  const { rows: msgs } = await db.query(
    `SELECT direction, message_body, timestamp FROM coexistence.chat_history
      WHERE wa_number = $1 AND contact_number = $2 ${s.clause}
        AND message_type NOT IN ('status','reaction')
      ORDER BY timestamp DESC LIMIT 10`,
    [waNumber, contactNumber, ...s.params]
  );
  for (const r of msgs) {
    push(r.direction === 'incoming' ? 'WhatsApp inbound' : 'WhatsApp outbound', r.timestamp,
      String(r.message_body || '').slice(0, 200) || null, null);
  }

  s = scoped('e', 2);
  const { rows: execs } = await db.query(
    `SELECT e.id, e.status, e.trigger_type, e.started_at, c.name AS automation_name
       FROM coexistence.automation_executions e
       LEFT JOIN coexistence.chatbots c ON c.id = e.automation_id
      WHERE e.contact_number = $1 ${s.clause}
      ORDER BY e.started_at DESC LIMIT 10`,
    [contactNumber, ...s.params]
  );
  for (const r of execs) {
    push('automation', r.started_at, `${r.automation_name || 'Automation'}: ${r.status} (${r.trigger_type})`, r.id);
  }

  items.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return items.slice(0, limitN);
}

module.exports = {
  LEAD_STATUSES,
  CrmError,
  digits,
  getLeadById,
  getLeadByContact,
  leadShape,
  enrichLead,
  listLeads,
  requireMember,
  addActivity,
  createLead,
  deleteLead,
  setLeadStatus,
  setLeadStage,
  assignLead,
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  listCalls,
  logCall,
  deleteCall,
  listFollowups,
  createFollowup,
  setFollowupStatus,
  getTimeline,
};

