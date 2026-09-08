// Green Pilot automation service (Phase 10).
//
// Owns: config validation (replaces the destructive sanitizeToLinear),
// tenant-scoped CRUD, trigger matching, the automation event bus, and
// idempotent execution creation. The engine walks; the queue carries; this
// module decides. No business logic is duplicated here — actions execute
// through the engine's service-backed handlers.

const { matchesKeyword } = require('../engine/automationEngine');

// Approved trigger kinds (Step 5). Legacy kinds (anyMessage/newContact/
// messageRead/…/link/qr/tagApplied) never fire; webhook/apiEvent are rejected
// at validation (no arbitrary inbound HTTP without a security review).
const APPROVED_TRIGGERS = new Set([
  'keyword',
  'message_received',
  'lead_created',
  'lead_qualified',
  'lead_status_changed',
  'followup_due',
]);

// Node types the walker supports in Phase 10. handoff/api/subflow are parked
// engine stubs and stay rejected (explicit 400, never silent deletion).
const APPROVED_NODE_TYPES = new Set(['trigger', 'message', 'condition', 'action', 'delay']);

const APPROVED_ACTION_KINDS = new Set([
  'Assign to BDA',
  'Add Tag',
  'Remove Tag',
  'Set Custom Field',
  'Clear Custom Field',
  'Add Note',
  'Schedule Follow-up',
  'Update Lead Status',
  'Invoke AI Qualification',
]);

// Event types the bus accepts.
const APPROVED_EVENT_TYPES = new Set([
  'whatsapp.message.received',
  'lead.created',
  'lead.qualified',
  'lead.status.changed',
  'followup.due',
]);

const MAX_DEPTH = 5;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.status = 400;
  }
}

// Validate + normalize an automation config. KEEPS approved nodes (the old
// sanitizeToLinear deleted them); REJECTS parked/unsafe types and trigger
// kinds with an explicit error instead of silently dropping user work.
function validateAutomationConfig(config) {
  if (!config || typeof config !== 'object') throw new ConfigError('config must be an object');
  const nodes = Array.isArray(config.nodes) ? config.nodes : [];
  const edges = Array.isArray(config.edges) ? config.edges : [];
  const triggers = nodes.filter((n) => n && n.type === 'trigger');
  if (triggers.length === 0) throw new ConfigError('Automation needs exactly one trigger node');
  if (triggers.length > 1) throw new ConfigError('Automation supports a single trigger node');
  const trigger = triggers[0];
  const kind = trigger.triggerKind || 'keyword';
  if (!APPROVED_TRIGGERS.has(kind)) {
    throw new ConfigError(`Unsupported trigger "${kind}". Approved: ${[...APPROVED_TRIGGERS].join(', ')}.`);
  }
  if (kind === 'keyword' && !String(trigger.keyword || '').trim()) {
    throw new ConfigError('A keyword trigger needs a keyword.');
  }
  const byId = new Map();
  for (const n of nodes) {
    if (!n || n.id == null) throw new ConfigError('Every node needs an id.');
    if (!APPROVED_NODE_TYPES.has(n.type)) {
      throw new ConfigError(
        `Unsupported node type "${n.type}". Approved: ${[...APPROVED_NODE_TYPES].join(', ')}.`
      );
    }
    if (byId.has(n.id)) throw new ConfigError(`Duplicate node id "${n.id}".`);
    byId.set(n.id, n);
    if (n.type === 'message' && (n.directType === 'dynamic_api' || n.messageMode === 'dynamic_api')) {
      throw new ConfigError('Dynamic API messages are disabled (SSRF boundary). Use Send Message templates or direct types.');
    }
    if (n.type === 'action') {
      for (const a of (Array.isArray(n.actions) ? n.actions : [])) {
        if (!APPROVED_ACTION_KINDS.has(a?.kind)) {
          throw new ConfigError(
            `Unsupported action "${a?.kind}". Approved: ${[...APPROVED_ACTION_KINDS].join(', ')}.`
          );
        }
      }
    }
  }
  const cleanEdges = [];
  for (const e of edges) {
    if (!e || e.from == null || e.to == null) continue;
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    cleanEdges.push({ from: e.from, to: e.to, fromHandle: e.fromHandle || 'default' });
  }
  return { ...config, nodes, edges: cleanEdges };
}

// --- Tenant access -------------------------------------------------------------

// Dual-read visibility (org match or legacy NULL; org-less callers see only
// legacy rows). Invisible reads as null → callers answer 404 (no probing).
async function getAutomationRow(db, id) {
  const { rows } = await db.query(
    `SELECT id, name, description, status, trigger_type, config, organization_id, created_at, updated_at
       FROM coexistence.chatbots WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

function automationVisibleToOrg(row, orgId) {
  if (!row) return false;
  if (!orgId) return row.organization_id == null;
  return row.organization_id == null || String(row.organization_id) === String(orgId);
}

async function assertAutomationAccess(db, req, id) {
  const row = await getAutomationRow(db, id);
  if (!row || !automationVisibleToOrg(row, req?.org?.id || null)) return null;
  return row;
}

// First management write by an org adopts legacy rows into that org.
async function adoptAutomationOrg(db, row, orgId) {
  if (!orgId || row.organization_id != null) return false;
  await db.query(
    `UPDATE coexistence.chatbots SET organization_id = $1, updated_at = NOW()
      WHERE id = $2 AND organization_id IS NULL`,
    [orgId, row.id]
  );
  return true;
}

function automationShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    trigger_type: row.trigger_type,
    config: row.config || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// --- Tenant-scoped CRUD (shared by legacy + canonical routers) ------------------

async function listAutomations(db, orgId) {
  const { rows } = await db.query(
    `SELECT id, name, description, status, trigger_type, config, created_at, updated_at
       FROM coexistence.chatbots
      WHERE ($1::uuid IS NULL AND organization_id IS NULL)
         OR ($1::uuid IS NOT NULL AND (organization_id = $1 OR organization_id IS NULL))
      ORDER BY updated_at DESC`,
    [orgId || null]
  );
  return rows.map(automationShape);
}

async function createAutomation(db, orgId, { name, description, status, trigger_type, config }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new ConfigError('Name is required');
  const clean = validateAutomationConfig(config || { nodes: [], edges: [] });
  const trigger = (clean.nodes || []).find((n) => n.type === 'trigger');
  const { rows } = await db.query(
    `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, name, description, status, trigger_type, config, created_at, updated_at`,
    [cleanName.slice(0, 200), description || null, status || 'draft',
      trigger_type || trigger?.triggerKind || 'keyword',
      JSON.stringify(clean), orgId || null]
  );
  return automationShape(rows[0]);
}

/**
 * @param {{query: Function}} db
 * @param {{id: number}} row
 * @param {{name?: string, description?: string, status?: string, trigger_type?: string, config?: object}} fields
 */
async function updateAutomation(db, row, { name, description, status, trigger_type, config } = {}) {
  if (name !== undefined && !String(name).trim()) throw new ConfigError('Name is required');
  const sets = ['updated_at = NOW()'];
  const params = [];
  let i = 1;
  if (name !== undefined) { sets.push(`name = $${i++}`); params.push(String(name).trim().slice(0, 200)); }
  if (description !== undefined) { sets.push(`description = $${i++}`); params.push(description || null); }
  if (status !== undefined) { sets.push(`status = $${i++}`); params.push(status); }
  if (trigger_type !== undefined) { sets.push(`trigger_type = $${i++}`); params.push(trigger_type); }
  if (config !== undefined) {
    const clean = validateAutomationConfig(config);
    sets.push(`config = $${i++}`);
    params.push(JSON.stringify(clean));
  }
  params.push(row.id);
  const { rows } = await db.query(
    `UPDATE coexistence.chatbots SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, name, description, status, trigger_type, config, created_at, updated_at`,
    params
  );
  return automationShape(rows[0]);
}

// --- Trigger matching ------------------------------------------------------------

// Pure: does this automation's trigger node fire for this event?
function automationMatchesTrigger(automation, event) {
  const config = automation.config || {};
  const nodes = config.nodes || [];
  const trigger = nodes.find((n) => n && n.type === 'trigger');
  if (!trigger) return false;
  const kind = trigger.triggerKind || 'keyword';

  // WhatsApp-account filter (pre-existing semantics): named accounts only.
  if (Array.isArray(trigger.triggerAccounts) && trigger.triggerAccounts.length > 0) {
    const wa = event.payload?.wa_number || event.payload?.waNumber;
    if (!wa || !trigger.triggerAccounts.includes(String(wa))) return false;
  }

  switch (kind) {
    case 'keyword': {
      if (event.eventType !== 'whatsapp.message.received') return false;
      const keyword = trigger.keyword || '';
      const matchType = trigger.matchType || 'exact';
      return matchesKeyword(event.payload?.message_body || event.payload?.body, keyword, matchType, !!trigger.caseSensitive);
    }
    case 'message_received':
      return event.eventType === 'whatsapp.message.received';
    case 'lead_created':
      return event.eventType === 'lead.created';
    case 'lead_qualified':
      return event.eventType === 'lead.qualified';
    case 'lead_status_changed':
      return event.eventType === 'lead.status.changed';
    case 'followup_due':
      return event.eventType === 'followup.due';
    default:
      return false;
  }
}

// --- Event bus ----------------------------------------------------------------------

// Emit one automation event: match org-visible active automations, create
// idempotent executions, enqueue worker jobs. Returns the executions created
// (synchronously — the webhook's agent fall-through depends on this).
// Loop safety: depth cap + visited-automation skip, logged not thrown.
/**
 * @param {{query: Function}} db
 * @param {{organizationId?: string, eventType?: string, entityId?: string|null,
 *   eventId?: string, payload?: Record<string,any>, depth?: number,
 *   visited?: string[]}} [event]
 */
async function emitAutomationEvent(db, {
  organizationId, eventType, entityId, eventId, payload = {}, depth = 0, visited = [],
} = {}) {
  if (!organizationId) throw new Error('organizationId is required');
  if (!APPROVED_EVENT_TYPES.has(eventType)) throw new Error(`unknown event type "${eventType}"`);
  if (!eventId) throw new Error('eventId is required');
  if (depth > MAX_DEPTH) {
    console.warn(`[automation] event ${eventId} dropped: depth ${depth} exceeds max ${MAX_DEPTH}`);
    return [];
  }
  const { rows: automations } = await db.query(
    `SELECT id, name, status, trigger_type, config, organization_id
       FROM coexistence.chatbots
      WHERE status = 'active'
        AND (organization_id = $1 OR organization_id IS NULL)`,
    [organizationId]
  );
  const event = {
    organizationId: String(organizationId),
    eventType, entityId: entityId || null, eventId: String(eventId),
    payload, depth, visited: Array.isArray(visited) ? visited.map(String) : [],
  };
  const created = [];
  for (const automation of automations) {
    if (event.visited.includes(String(automation.id))) continue; // loop guard
    let matches = false;
    try {
      matches = automationMatchesTrigger(automation, event);
    } catch (err) {
      console.error(`[automation] trigger match failed for ${automation.id}:`, err.message);
      continue;
    }
    if (!matches) continue;
    const { rows } = await db.query(
      `INSERT INTO coexistence.automation_executions
         (automation_id, organization_id, status, trigger_type, trigger_data,
          contact_number, event_id, depth, started_at)
       VALUES ($1,$2,'queued',$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (organization_id, automation_id, event_id) DO NOTHING
       RETURNING *`,
      [automation.id, organizationId, eventType, JSON.stringify({ ...payload, eventId }),
        payload.contact_number || payload.contactNumber || null, event.eventId, depth]
    );
    let execution = rows[0] || null;
    let duplicate = false;
    if (!execution) {
      const { rows: existing } = await db.query(
        `SELECT * FROM coexistence.automation_executions
          WHERE organization_id = $1 AND automation_id = $2 AND event_id = $3`,
        [organizationId, automation.id, event.eventId]
      );
      execution = existing[0] || null;
      duplicate = true;
    }
    if (!execution) continue;
    created.push({ execution, duplicate, automationId: automation.id });
    if (!duplicate) {
      try {
        // Lazy require: the queue module loads BullMQ/Redis at import.
        const { enqueueAutomationRun } = require('../queue/automationQueue');
        await enqueueAutomationRun({
          organizationId: String(organizationId),
          automationId: automation.id,
          executionId: execution.id,
          eventId: event.eventId,
        });
      } catch (err) {
        console.error('[automation] enqueue failed:', err.message);
      }
    }
  }
  return created;
}

// Webhook inbound entry: emits whatsapp.message.received (always) and
// lead.created (first-ever inbound from this contact only). Returns created
// executions for the agent fall-through contract. Message persistence is the
// durable context — these events only route.
async function handleInboundMessage(db, record, organizationId) {
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const wa = digits(record.wa_number);
  const contact = digits(record.contact_number);
  if (!wa || !contact || !record.message_id) return [];
  const basePayload = {
    message_id: record.message_id,
    wa_number: wa,
    contact_number: contact,
    phone_number_id: record.phone_number_id || null,
    message_type: record.message_type || 'text',
    message_body: typeof record.message_body === 'string' ? record.message_body.slice(0, 4000) : null,
    timestamp: record.timestamp || new Date().toISOString(),
  };
  const fired = await emitAutomationEvent(db, {
    organizationId,
    eventType: 'whatsapp.message.received',
    entityId: String(record.message_id),
    eventId: inboundEventId(record.message_id),
    payload: basePayload,
  });

  // New-lead detection: no earlier inbound from this pair besides the current
  // message (mirrors the agent router's 'new' semantics, org-scoped).
  const { rows: prior } = await db.query(
    `SELECT 1 FROM coexistence.chat_history
      WHERE organization_id = $1 AND wa_number = $2 AND contact_number = $3
        AND direction = 'incoming' AND message_id IS DISTINCT FROM $4
      LIMIT 1`,
    [organizationId, wa, contact, record.message_id]
  );
  if (prior.length === 0) {
    const created = await emitAutomationEvent(db, {
      organizationId,
      eventType: 'lead.created',
      entityId: `${wa}:${contact}`,
      eventId: leadCreatedEventId(organizationId, wa, contact),
      payload: { ...basePayload, is_new_lead: true },
    });
    fired.push(...created);
  }
  return fired;
}
// Follow-up due sweeper (called every 60s from index.js): atomically claims
// pending rows whose due_at passed (pending→done, at-most-once per row) and
// emits followup.due. Claimed rows are consumed even when no automation
// matches — a due follow-up with no workflow has nothing left to do.
async function sweepDueFollowups(db) {
  const { rows } = await db.query(
    `UPDATE coexistence.follow_ups SET status = 'done'
      WHERE status = 'pending' AND due_at <= NOW()
      RETURNING id, organization_id, contact_ref, due_at, assigned_to`
  );
  let emitted = 0;
  for (const row of rows) {
    try {
      // follow_ups carry no wa_number — resolve the conversation's number so
      // downstream actions have full context (null fails closed downstream).
      let waNumber = null;
      if (row.contact_ref) {
        const { rows: conv } = await db.query(
          `SELECT wa_number FROM coexistence.conversations
            WHERE organization_id = $1 AND contact_number = $2
            ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
          [row.organization_id, row.contact_ref]
        );
        waNumber = conv[0]?.wa_number || null;
      }
      const created = await emitAutomationEvent(db, {
        organizationId: row.organization_id,
        eventType: 'followup.due',
        entityId: String(row.id),
        eventId: followupDueEventId(row.id, row.due_at),
        payload: {
          follow_up_id: String(row.id),
          wa_number: waNumber,
          contact_number: row.contact_ref,
          due_at: row.due_at,
          assigned_to: row.assigned_to,
        },
      });
      if (created.length > 0) emitted += 1;
    } catch (err) {
      console.error('[automation] followup.due emit failed:', err.message);
    }
  }
  return { claimed: rows.length, emitted };
}

function inboundEventId(messageId) {
  return `msg:${messageId}`;
}
function leadCreatedEventId(orgId, waNumber, contactNumber) {
  return `lead:${orgId}:${waNumber}:${contactNumber}`;
}
function qualifiedEventId(qualificationId) {
  return `qualified:${qualificationId}`;
}
function statusChangedEventId(qualificationId) {
  return `status:${qualificationId}`;
}
function followupDueEventId(followupId, dueAt) {
  return `followup:${followupId}:${new Date(dueAt).toISOString()}`;
}

module.exports = {
  APPROVED_TRIGGERS,
  APPROVED_NODE_TYPES,
  APPROVED_ACTION_KINDS,
  APPROVED_EVENT_TYPES,
  MAX_DEPTH,
  ConfigError,
  validateAutomationConfig,
  getAutomationRow,
  automationVisibleToOrg,
  assertAutomationAccess,
  adoptAutomationOrg,
  automationShape,
  listAutomations,
  createAutomation,
  updateAutomation,
  automationMatchesTrigger,
  emitAutomationEvent,
  handleInboundMessage,
  sweepDueFollowups,
  inboundEventId,
  leadCreatedEventId,
  qualifiedEventId,
  statusChangedEventId,
  followupDueEventId,
};
