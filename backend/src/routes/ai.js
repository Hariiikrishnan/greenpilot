// Green Pilot AI API (Phase 9, canonical /api/v1/ai/*).
//
// Reads: any org member. The conversation-mode toggle additionally requires
// contact access (assertContactAccess). No provider secrets, prompts, or
// chain-of-thought ever leave these endpoints.

const { Router } = require('express');
const pool = require('../db');
const { requireOrg } = require('../middleware/tenant');
const { assertContactAccess } = require('../middleware/access');
const { subscriptionState, ensureSubscription } = require('../billing/subscriptions');
const { orgQuotaSnapshot } = require('../billing/quotas');
const { listProviders } = require('../llm');

const router = Router();

function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

// GET /ai/status — entitlement, quota, provider + qualification readiness.
router.get('/ai/status', requireOrg, async (req, res) => {
  try {
    const sub = await ensureSubscription(pool, req.org.id);
    const { state, entitled } = subscriptionState(sub);
    const usage = await orgQuotaSnapshot(pool, req.org.id);
    let providers = [];
    try { providers = listProviders(); } catch { providers = []; }
    const { rows: q } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.agents
        WHERE is_active = TRUE AND qualify_leads = TRUE
          AND organization_id = $1`,
      [req.org.id]
    );
    res.json({
      organizationId: req.org.id,
      entitled,
      subscriptionState: state,
      usage: { granted: usage.granted, used: usage.used, remaining: usage.remaining },
      providers,
      qualifyingAgents: q[0]?.n || 0,
      canManageBilling: req.org.role === 'owner' || req.org.role === 'admin',
      pricingFinalized: false,
    });
  } catch (err) {
    console.error('[ai] status error:', err.message);
    res.status(500).json({ error: 'Failed to load AI status' });
  }
});

// GET /ai/qualifications — recent results for the org (member-visible).
// Optional ?waNumber=&contactNumber= narrows to one conversation (latest first).
router.get('/ai/qualifications', requireOrg, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '20', 10)));
    const wa = digits(req.query.waNumber);
    const contact = digits(req.query.contactNumber);
    const params = [req.org.id];
    let extra = '';
    if (wa && contact) {
      extra = 'AND wa_number = $2 AND contact_number = $3';
      params.push(wa, contact);
    }
    const { rows } = await pool.query(
      `SELECT id, conversation_id, wa_number, contact_number, agent_id,
              inbound_message_id, status, score, intent, summary, evaluated_at
         FROM coexistence.lead_qualifications
        WHERE organization_id = $1 ${extra}
        ORDER BY evaluated_at DESC
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    res.json(rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      waNumber: r.wa_number,
      contactNumber: r.contact_number,
      agentId: r.agent_id,
      status: r.status,
      score: r.score,
      intent: r.intent,
      summary: r.summary,
      evaluatedAt: r.evaluated_at,
    })));
  } catch (err) {
    console.error('[ai] qualifications error:', err.message);
    res.status(500).json({ error: 'Failed to load qualifications' });
  }
});

// GET /ai/qualifications/:id — single result, org-scoped (404 otherwise).
router.get('/ai/qualifications/:id', requireOrg, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, conversation_id, wa_number, contact_number, agent_id,
              inbound_message_id, status, score, intent, summary, evaluated_at
         FROM coexistence.lead_qualifications
        WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.org.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    res.json({
      id: r.id,
      conversationId: r.conversation_id,
      waNumber: r.wa_number,
      contactNumber: r.contact_number,
      agentId: r.agent_id,
      status: r.status,
      score: r.score,
      intent: r.intent,
      summary: r.summary,
      evaluatedAt: r.evaluated_at,
    });
  } catch (err) {
    console.error('[ai] qualification detail error:', err.message);
    res.status(500).json({ error: 'Failed to load qualification' });
  }
});

// GET /ai/usage — quota snapshot + recent ledger rows (member-visible).
router.get('/ai/usage', requireOrg, async (req, res) => {
  try {
    const usage = await orgQuotaSnapshot(pool, req.org.id);
    const { rows } = await pool.query(
      `SELECT inbound_message_id, agent_id, contact_number, model,
              tokens_in, tokens_out, cost_credits, created_at
         FROM coexistence.ai_usage_ledger
        WHERE organization_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.org.id]
    );
    res.json({
      organizationId: req.org.id,
      usage: { granted: usage.granted, used: usage.used, remaining: usage.remaining },
      recent: rows.map((r) => ({
        inboundMessageId: r.inbound_message_id,
        agentId: r.agent_id,
        contactNumber: r.contact_number,
        model: r.model,
        tokensIn: r.tokens_in,
        tokensOut: r.tokens_out,
        costCredits: r.cost_credits,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[ai] usage error:', err.message);
    res.status(500).json({ error: 'Failed to load AI usage' });
  }
});

// POST /ai/conversation-mode { waNumber, contactNumber, enabled } — persistent
// backend-enforced AI mode for one conversation (member with contact access).
router.post('/ai/conversation-mode', requireOrg, async (req, res) => {
  try {
    const { waNumber, contactNumber, enabled } = req.body || {};
    if (!waNumber || !contactNumber || enabled === undefined) {
      return res.status(400).json({ error: 'waNumber, contactNumber and enabled are required' });
    }
    if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
    const wa = digits(waNumber);
    const contact = digits(contactNumber);
    const { rowCount } = await pool.query(
      `UPDATE coexistence.conversations SET ai_enabled = $1, updated_at = NOW()
        WHERE organization_id = $2 AND wa_number = $3 AND contact_number = $4`,
      [!!enabled, req.org.id, wa, contact]
    );
    if (rowCount === 0) {
      // No thread yet (e.g. toggling before first inbound): create a stub row
      // so the mode is durable. Account left NULL; the webhook backfills the
      // canonical thread on first traffic.
      await pool.query(
        `INSERT INTO coexistence.conversations
           (organization_id, whatsapp_account_id, wa_number, contact_number, ai_enabled)
         VALUES ($1, NULL, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [req.org.id, wa, contact, !!enabled]
      );
    }
    res.json({ ok: true, waNumber: wa, contactNumber: contact, aiEnabled: !!enabled });
  } catch (err) {
    console.error('[ai] conversation-mode error:', err.message);
    res.status(500).json({ error: 'Failed to update AI mode' });
  }
});

module.exports = { router };
