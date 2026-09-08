// Green Pilot canonical realtime event emission (Phase 7).
//
// Boundary rule: every emit REQUIRES an explicit organizationId and targets
// ONLY `org:{organizationId}`. The org is never inferred from global state,
// the last processed job, or any "currently selected" frontend value —
// callers pass it through from the tenant-validated context they already hold
// (webhook org, queue job org, request org).
//
// Payload rule: emitters sanitize to the documented contract (see
// PHASE7_SOCKET_EVENT_CONTRACT.md). Secrets, tokens, raw payloads, and
// internal AI data never leave the server.
//
// Dual emit: canonical Socket.IO room emit + legacy SSE bus emit (compat until
// the frontend cutover completes; the SSE route only forwards message-status).

const CANONICAL_EVENTS = [
  'inbound-message',
  'message-status-update',
  'conversation-updated',
  'unread-count-update',
  'lead-qualified',
];

// Extended org-scoped UI events preserved from the legacy bus (team inbox
// affordances). Same tenant boundary + sanitization rules apply.
const EXTENDED_EVENTS = [
  'contact-saved',
  'contact-assignment-changed',
  'agent-handoff',
  'agent-resumed',
  // Phase 10 automation execution lifecycle (worker-emitted, org rooms only).
  'automation-started',
  'automation-completed',
  'automation-failed',
  // Phase 11 CRM lifecycle (ids + hints only; detail via API).
  'lead-created',
  'lead-updated',
  'lead-assigned',
  'lead-status-changed',
  'followup-created',
  'followup-completed',
  'activity-created',
];

const ALLOWED_EVENTS = new Set([...CANONICAL_EVENTS, ...EXTENDED_EVENTS]);

// Legacy SSE name mapping (routes/events.js forwards only message-status).
const SSE_ALIASES = {
  'message-status-update': 'message-status',
};

function requireOrgId(organizationId) {
  if (!organizationId || String(organizationId).trim() === '') {
    throw new Error('[realtime] organizationId is required — refusing unscoped emit');
  }
  return String(organizationId);
}

function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

function sanitizeBase(payload) {
  // Defensive strip: even if a caller passes extra keys, secrets never emit.
  const banned = [
    'accessToken', 'access_token', 'token', 'secret', 'verifyToken',
    'verify_token', 'password', 'apiKey', 'api_key', 'rawPayload', 'raw_payload',
    'headers', 'cookie', 'authorization',
  ];
  const out = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (banned.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// Emit one event to exactly one organization room. Returns true when a room
// emit was attempted, false when no Socket.IO server is attached (e.g. tests
// booting { app } without start(), or pre-init). Never throws for a missing
// server — realtime is best-effort on top of persisted state.
function emitToOrg(organizationId, event, payload = {}) {
  const orgId = requireOrgId(organizationId);
  if (!ALLOWED_EVENTS.has(event)) {
    throw new Error(`[realtime] unknown event "${event}" — refusing emit`);
  }
  const safe = sanitizeBase(payload);
  try {
    const { getIO, orgRoom } = require('./socket');
    const io = getIO();
    if (io) io.to(orgRoom(orgId)).emit(event, { ...safe, organizationId: orgId });
  } catch (err) {
    console.error('[realtime] socket emit failed:', err.message);
  }
  // Legacy SSE compat (best-effort; forwarded only where the SSE route listens).
  try {
    const bus = require('../events');
    const alias = SSE_ALIASES[event];
    if (alias) bus.emit(alias, safe);
    else if (EXTENDED_EVENTS.includes(event)) bus.emit(event, safe);
    else bus.emit(event, safe);
  } catch { /* bus missing — socket already delivered */ }
  return true;
}

// --- Canonical event constructors (payloads per the event contract) --------

function emitInboundMessage(organizationId, record = {}) {
  return emitToOrg(organizationId, 'inbound-message', {
    messageId: record.message_id || record.messageId || null,
    waNumber: digitsOnly(record.wa_number || record.waNumber),
    contactNumber: digitsOnly(record.contact_number || record.contactNumber),
    direction: record.direction || 'incoming',
    messageType: record.message_type || record.messageType || 'text',
    body: typeof (record.message_body ?? record.body) === 'string'
      ? String(record.message_body ?? record.body).slice(0, 4000)
      : null,
    status: record.status || 'received',
    timestamp: record.timestamp || new Date().toISOString(),
    contextMessageId: record.context_message_id || record.contextMessageId || null,
    eventId: `inbound-${record.message_id || record.messageId || Date.now()}`,
  });
}

const STATUS_FLOW = ['sending', 'sent', 'delivered', 'read', 'played', 'failed', 'received'];

function emitMessageStatus(organizationId, status = {}) {
  const s = String(status.status || '').toLowerCase();
  if (!STATUS_FLOW.includes(s)) return false; // never fabricate transitions
  return emitToOrg(organizationId, 'message-status-update', {
    messageId: status.messageId || status.message_id || null,
    waNumber: digitsOnly(status.waNumber || status.wa_number),
    contactNumber: digitsOnly(status.contactNumber || status.contact_number),
    status: s,
    timestamp: status.timestamp || new Date().toISOString(),
    eventId: `status-${status.messageId || status.message_id || Date.now()}-${s}`,
  });
}

// Automation execution lifecycle (Phase 10): ids + status only.
function emitAutomationEvent(organizationId, name, execution = {}) {
  return emitToOrg(organizationId, name, {
    automationId: execution.automationId || execution.automation_id || null,
    executionId: execution.executionId || execution.id || null,
    status: execution.status || null,
    eventId: `auto-${execution.executionId || execution.id || Date.now()}-${name}`,
  });
}

function emitConversationUpdated(organizationId, conversation = {}) {
  return emitToOrg(organizationId, 'conversation-updated', {
    waNumber: digitsOnly(conversation.waNumber || conversation.wa_number),
    contactNumber: digitsOnly(conversation.contactNumber || conversation.contact_number),
    lastMessageAt: conversation.lastMessageAt || conversation.last_message_at || new Date().toISOString(),
    unreadCount: Number.isFinite(+conversation.unreadCount) ? +conversation.unreadCount : null,
    assignment: conversation.assignment || conversation.assignedUserId || null,
    conversationStatus: conversation.conversationStatus || conversation.status || null,
    lastMessagePreview: typeof conversation.lastMessagePreview === 'string'
      ? conversation.lastMessagePreview.slice(0, 280)
      : (typeof conversation.lastMessageBody === 'string' ? conversation.lastMessageBody.slice(0, 280) : null),
    eventId: `conv-${digitsOnly(conversation.contactNumber || conversation.contact_number)}-${Date.now()}`,
  });
}

// Qualification contract only (Phase 7): the future AI stage fills in score/
// tier/summary. Carries ids + refresh hints, never prompts/model internals.
function emitLeadQualified(organizationId, qualification = {}) {
  return emitToOrg(organizationId, 'lead-qualified', {
    contactNumber: digitsOnly(qualification.contactNumber || qualification.contact_number),
    waNumber: digitsOnly(qualification.waNumber || qualification.wa_number),
    leadId: qualification.leadId || qualification.lead_id || null,
    conversationId: qualification.conversationId || qualification.conversation_id || null,
    qualified: qualification.qualified !== false,
    qualifiedAt: qualification.qualifiedAt || qualification.qualified_at || new Date().toISOString(),
    eventId: `leadq-${digitsOnly(qualification.contactNumber || qualification.contact_number)}-${Date.now()}`,
  });
}

function emitUnreadCountUpdate(organizationId, payload = {}) {
  const unreadCount = Number.isFinite(+payload.unreadCount) ? +payload.unreadCount : 0;
  return emitToOrg(organizationId, 'unread-count-update', {
    waNumber: digitsOnly(payload.waNumber || payload.wa_number),
    contactNumber: digitsOnly(payload.contactNumber || payload.contact_number),
    unreadCount,
    timestamp: payload.timestamp || new Date().toISOString(),
    eventId: `unread-${digitsOnly(payload.contactNumber || payload.contact_number)}-${Date.now()}`,
  });
}

// CRM lifecycle (Phase 11): lead identity + change hint only.
function emitCrmEvent(organizationId, name, lead = {}) {
  return emitToOrg(organizationId, name, {
    leadId: lead.leadId || lead.id || null,
    waNumber: digitsOnly(lead.waNumber || lead.wa_number),
    contactNumber: digitsOnly(lead.contactNumber || lead.contact_number),
    kind: lead.kind || lead.activityKind || null,
    eventId: `crm-${lead.leadId || lead.id || digitsOnly(lead.contactNumber || lead.contact_number)}-${name}-${Date.now()}`,
  });
}

module.exports = {
  CANONICAL_EVENTS,
  EXTENDED_EVENTS,
  ALLOWED_EVENTS,
  emitToOrg,
  emitInboundMessage,
  emitMessageStatus,
  emitConversationUpdated,
  emitUnreadCountUpdate,
  emitLeadQualified,
  emitAutomationEvent,
  emitCrmEvent,
};
