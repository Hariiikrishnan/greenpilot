// Green Pilot AI Lead Qualification (Phase 9).
//
// Pipeline: eligibility → duplicate-check → structured-output LLM call (NO
// tools — extraction only) → zod validation → persist qualification + CRM
// timeline → Phase-8 usage ledger → tenant-scoped lead-qualified emit.
//
// Money rules (Phase 8 verbatim): no debit before validated success; provider
// failure/timeout/malformed output/ineligibility/duplicates are NEVER charged.
// The agent's own run is charged separately by the queue worker under the
// inbound message key; the qualification charges under message+'#qualify'.

const { getProvider } = require('../llm');
const { AiError, getAgentRow, agentVisibleToOrg } = require('./access');
const { withSecurityPreamble } = require('./security');
const { parseQualificationResult } = require('./validation');
const { checkQuota, recordAiUsage } = require('../billing/quotas');

const RUN_COST = 1;
const QUALIFICATION_COST = 1;
const PROVIDER_TIMEOUT_MS = 90000;

function timeoutError() {
  return new AiError('AI provider timed out', 504, 'provider-timeout');
}

function withTimeout(promise, ms = PROVIDER_TIMEOUT_MS) {
  let timer = null;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, gate]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Read-only gate. `agent` is the joined agent row (may be null). Never mutates,
// never charges — safe to call from eligibility probes and the worker alike.
async function checkEligibility(db, { organizationId, agent, waNumber, contactNumber }) {
  if (!organizationId) return { eligible: false, reason: 'no-organization' };
  if (!agent) return { eligible: false, reason: 'no-agent' };
  if (!agentVisibleToOrg(agent, organizationId)) return { eligible: false, reason: 'foreign-agent' };
  if (!agent.is_active) return { eligible: false, reason: 'agent-inactive' };
  if (!agent.qualify_leads) return { eligible: false, reason: 'not-enabled' };
  if (!agent.ai_provider) return { eligible: false, reason: 'no-model' };

  // Persistent AI mode: conversation opt-out disables; missing row = enabled.
  if (waNumber && contactNumber) {
    const { rows: conv } = await db.query(
      `SELECT ai_enabled FROM coexistence.conversations
        WHERE organization_id = $1 AND wa_number = $2 AND contact_number = $3
        ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
      [organizationId, waNumber, contactNumber]
    );
    if (conv[0] && conv[0].ai_enabled === false) {
      return { eligible: false, reason: 'ai-disabled' };
    }
    // Human take-over pauses AI for this contact.
    const { rows: paused } = await db.query(
      `SELECT agent_paused FROM coexistence.contacts
        WHERE organization_id = $1 AND wa_number = $2 AND contact_number = $3
        LIMIT 1`,
      [organizationId, waNumber, contactNumber]
    );
    if (paused[0]?.agent_paused) return { eligible: false, reason: 'paused-for-human' };
  }

  // Billing authority: entitlement + availability, read-only here.
  const quota = await checkQuota(db, organizationId, 'ai_credits', QUALIFICATION_COST);
  if (!quota.allowed) return { eligible: false, reason: quota.reason, state: quota.state };
  return { eligible: true, reason: 'ok' };
}

function buildQualificationPrompt(agent) {
  const rules = (agent?.qualification_rules || '').trim().slice(0, 2000);
  const instruction = [
    'You qualify an inbound WhatsApp sales lead for a business.',
    'Read the conversation transcript below and output ONLY a JSON object (no code fences, no commentary) with exactly these keys:',
    '- status: one of "qualified", "unqualified", "needs-more-information", "unknown".',
    '  Mark "qualified" only when the transcript shows genuine buying intent or a concrete next step.',
    '  Mark "unqualified" only on explicit disinterest. Otherwise use "needs-more-information" or "unknown".',
    '- score: integer 0-100 confidence in the status, or null when unknown.',
    '- intent: short intent label (e.g. "pricing question", "demo request"), or null.',
    '- budget: budget information the customer stated, or null. Never invent numbers.',
    '- timeline: timing the customer stated, or null. Never invent dates.',
    '- requirements: what the customer asked for, or null.',
    '- summary: 1-3 sentence factual summary of the conversation. Required.',
    'Unknown fields stay null. Never fabricate values.',
  ].join('\n');
  const withRules = rules ? `${instruction}\n\n## Organization qualification rules\n${rules}` : instruction;
  return withSecurityPreamble(withRules);
}

function transcriptFrom(messages) {
  return (messages || [])
    .map((m) => `${m.direction === 'outgoing' ? 'Business' : 'Customer'}: ${m.message_body || ''}`)
    .join('\n')
    .slice(0, 12000);
}

async function recentMessages(db, { organizationId, waNumber, contactNumber, limit }) {
  const n = Math.max(1, Math.min(20, limit || 10));
  const { rows } = await db.query(
    `SELECT direction, message_body, timestamp
       FROM coexistence.chat_history
      WHERE organization_id = $1 AND wa_number = $2 AND contact_number = $3
        AND message_type <> 'status'
      ORDER BY timestamp DESC LIMIT $4`,
    [organizationId, waNumber, contactNumber, n]
  );
  return rows.reverse();
}

function qualificationShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    conversationId: row.conversation_id,
    waNumber: row.wa_number,
    contactNumber: row.contact_number,
    agentId: row.agent_id,
    inboundMessageId: row.inbound_message_id,
    status: row.status,
    score: row.score,
    intent: row.intent,
    summary: row.summary,
    evaluatedAt: row.evaluated_at,
  };
}

// Execute one qualification for a durable inbound message. Safe to retry:
// duplicates return the existing row without LLM calls or charges.
async function runQualification(db, {
  organizationId, agentId, conversationId = null,
  waNumber, contactNumber, inboundMessageId, agentRunId = null,
}) {
  if (!organizationId || !inboundMessageId || !waNumber || !contactNumber) {
    throw new Error('organizationId, waNumber, contactNumber and inboundMessageId are required');
  }
  const agent = await getAgentRow(db, agentId);
  if (!agent || !agentVisibleToOrg(agent, organizationId)) {
    throw new AiError('Agent not found for this organization', 404);
  }

  const eligibility = await checkEligibility(db, { organizationId, agent, waNumber, contactNumber });
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };

  const { rows: existing } = await db.query(
    `SELECT * FROM coexistence.lead_qualifications
      WHERE organization_id = $1 AND inbound_message_id = $2`,
    [organizationId, inboundMessageId]
  );
  if (existing[0]) {
    return { ok: true, duplicate: true, qualification: qualificationShape(existing[0]) };
  }

  const messages = await recentMessages(db, {
    organizationId, waNumber, contactNumber, limit: agent.context_window_messages,
  });
  const provider = getProvider(agent.ai_provider);
  let raw;
  try {
    const result = await withTimeout(provider.runWithTools({
      systemPrompt: buildQualificationPrompt(agent),
      messages: [{ role: 'user', content: `## Conversation transcript\n${transcriptFrom(messages)}` }],
      tools: [], // extraction only — the model cannot act here
      onToolCall: async () => { throw new Error('Qualification does not use tools'); },
      onStep: async () => {},
      model: agent.llm_model,
      apiKey: agent.ai_api_key_encrypted
        ? require('../util/crypto').decrypt(agent.ai_api_key_encrypted)
        : (process.env[agent.ai_provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'] || ''),
      maxIterations: 1,
    }));
    raw = result?.finalText;
  } catch (err) {
    // Provider failure/timeout: nothing persisted, nothing charged. The queue
    // worker may retry; each retry re-enters this function idempotently.
    return { ok: false, reason: err?.code === 'provider-timeout' ? 'provider-timeout' : 'provider-failed' };
  }

  const parsed = parseQualificationResult(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason }; // no charge
  const v = parsed.value;

  // Persist first (still uncharged), guarded by the idempotency UNIQUE.
  const { rows: inserted } = await db.query(
    `INSERT INTO coexistence.lead_qualifications
       (organization_id, conversation_id, wa_number, contact_number,
        agent_id, agent_run_id, inbound_message_id, status, score,
        intent, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (organization_id, inbound_message_id) DO NOTHING
     RETURNING *`,
    [organizationId, conversationId, waNumber, contactNumber,
      agent.id, agentRunId, inboundMessageId, v.status, v.score,
      v.intent, v.summary]
  );
  if (!inserted[0]) {
    const { rows: raced } = await db.query(
      `SELECT * FROM coexistence.lead_qualifications
        WHERE organization_id = $1 AND inbound_message_id = $2`,
      [organizationId, inboundMessageId]
    );
    return { ok: true, duplicate: true, qualification: qualificationShape(raced[0]) };
  }

  // Charge only after validated persistence. Lost quota races compensate by
  // removing the just-inserted row — no orphan, no charge.
  try {
    await recordAiUsage(db, {
      organizationId, userId: null, agentId: agent.id, contactNumber,
      inboundMessageId: `${inboundMessageId}#qualify`,
      model: agent.llm_model, tokensIn: 0, tokensOut: 0, costCredits: QUALIFICATION_COST,
    });
  } catch (chargeErr) {
    await db.query(`DELETE FROM coexistence.lead_qualifications WHERE id = $1`, [inserted[0].id]);
    return { ok: false, reason: chargeErr?.code || 'quota-failed' };
  }

  // Auditable CRM timeline entry (concise summary, never reasoning).
  try {
    await db.query(
      `INSERT INTO coexistence.lead_notes (organization_id, contact_ref, body, created_by)
       VALUES ($1, $2, $3, NULL)`,
      [organizationId, contactNumber, `AI qualification: ${v.status}${v.score != null ? ` (score ${v.score})` : ''} — ${v.summary}`.slice(0, 2000)]
    );
  } catch (noteErr) {
    console.error('[qualification] timeline note failed:', noteErr.message);
  }

  // Phase 10 cascade: lead.qualified always; lead.status.changed when this
  // verdict differs from the conversation's previous one. Executions are
  // created idempotently; enqueue failures never fail the qualification.
  try {
    const autoService = require('../automation/service');
    const qid = String(inserted[0].id);
    await autoService.emitAutomationEvent(db, {
      organizationId, eventType: 'lead.qualified', entityId: qid,
      eventId: autoService.qualifiedEventId(qid),
      payload: {
        qualification_id: qid, conversation_id: conversationId,
        wa_number: waNumber, contact_number: contactNumber,
        status: v.status, score: v.score, intent: v.intent,
      },
    });
    const { rows: prevRows } = await db.query(
      `SELECT status FROM coexistence.lead_qualifications
        WHERE organization_id = $1 AND wa_number = $2 AND contact_number = $3
          AND id IS DISTINCT FROM $4
        ORDER BY evaluated_at DESC LIMIT 1`,
      [organizationId, waNumber, contactNumber, inserted[0].id]
    );
    if (prevRows[0] && prevRows[0].status !== v.status) {
      await autoService.emitAutomationEvent(db, {
        organizationId, eventType: 'lead.status.changed', entityId: qid,
        eventId: autoService.statusChangedEventId(qid),
        payload: {
          qualification_id: qid, conversation_id: conversationId,
          wa_number: waNumber, contact_number: contactNumber,
          status: v.status, previous_status: prevRows[0].status, score: v.score,
        },
      });
    }
  } catch (autoErr) {
    console.error('[qualification] automation emit failed:', autoErr.message);
  }

  // Tenant-scoped realtime (ids + status hint only; detail via API).
  try {
    require('../realtime/emitter').emitLeadQualified(organizationId, {
      contactNumber, waNumber,
      conversationId, qualified: v.status === 'qualified',
    });
  } catch (emitErr) {
    console.error('[qualification] realtime emit failed:', emitErr.message);
  }

  return { ok: true, duplicate: false, qualification: qualificationShape(inserted[0]) };
}

module.exports = {
  RUN_COST,
  QUALIFICATION_COST,
  checkEligibility,
  buildQualificationPrompt,
  transcriptFrom,
  runQualification,
};
