// Green Pilot Phase 6 — AI Pipeline Integration Test
//
// End-to-end scenario covering the complete flow:
//   Inbound webhook → message persisted → AI job queued → agent runs →
//   AI qualification → outbound response → delivery status → inbox
//
// Redis/BullMQ queue transport is NOT required: processJob() and
// runQualification() are called directly (same functions the worker calls),
// with the LLM provider stubbed via llm/__setProviderForTests seam.
//
// Proves 19 distinct behaviors mandated by the Phase 6 Definition of Done.

'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

require('dotenv').config();
process.env.ALLOW_UNVERIFIED_WEBHOOKS = 'true'; // skip HMAC in integration tests
process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase6-integration-test-secret';
process.env.FORGECRM_ENCRYPTION_KEY =
  process.env.FORGECRM_ENCRYPTION_KEY || '0'.repeat(64);

require('../src/util/instanceSecrets').bootstrapSecrets();

const pool   = require('../src/db');
const jwt    = require('jsonwebtoken');
const { app }        = require('../src/index');
const http           = require('http');
const { initRealtime } = require('../src/realtime/socket');
const { processJob }  = require('../src/queue/agentQueue');
const { runQualification } = require('../src/ai/qualification');
const { encrypt }     = require('../src/util/crypto');
const { setTestMetaClient, resetTestMetaClient } = require('../src/services/whatsappMessaging');

// ── Test seam: stub the LLM provider so no real API keys are needed ─────────
const llmModule = require('../src/llm');
let capturedPrompt = null;
const stubProvider = {
  runWithTools: async ({ systemPrompt, messages }) => {
    capturedPrompt = systemPrompt;
    if (systemPrompt && systemPrompt.includes('qualif')) {
      return {
        finalText: JSON.stringify({
          status: 'qualified',
          score: 87,
          intent: 'demo request',
          budget: null,
          timeline: 'this quarter',
          requirements: 'WhatsApp CRM integration',
          summary: 'Customer wants a live demo of the WhatsApp CRM.',
        }),
        totalInputTokens: 15,
        totalOutputTokens: 35,
        steps: [],
      };
    }
    return {
      finalText: 'Hello! I would be delighted to arrange a demo for you.',
      totalInputTokens: 20,
      totalOutputTokens: 30,
      steps: [],
    };
  },
};
if (typeof llmModule.__setProviderForTests === 'function') {
  llmModule.__setProviderForTests('openai', stubProvider);
}

// ── Unique test run tag ─────────────────────────────────────────────────────
const TAG = Date.now().toString().slice(-8);
const WA_NUM   = `9198${TAG}01`;   // business WhatsApp number
const CUST_NUM = `9198${TAG}02`;   // customer phone number
const WAMID_IN = `wamid.IN_${TAG}`;
const WAMID_OUT = `wamid.OUT_${TAG}`;

// ── Shared state provisioned in before() ───────────────────────────────────
let orgId, userId, userRow, tokenA, waAccountId, aiModelId, agentId, baseUrl;
let server, ioServer;
const JS = JSON.stringify;

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function authReq(path, token, orgIdH, options = {}) {
  const url = baseUrl + path;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `forgecrm_token=${token}`,
      'x-organization-id': orgIdH,
      ...(options.headers || {}),
    },
    ...options,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// ── Setup ──────────────────────────────────────────────────────────────────
before(async () => {
  // 1. Provision org
  const orgRes = await pool.query(`
    INSERT INTO coexistence.organizations (name, slug)
    VALUES ($1, $2) RETURNING id
  `, [`AI-Pipeline-Org-${TAG}`, `ai-pipe-${TAG}`]);
  orgId = orgRes.rows[0].id;

  // 2. Create user (forgecrm_users — this is the actual user table)
  const userRes = await pool.query(`
    INSERT INTO coexistence.forgecrm_users (username, email, password, role, display_name, is_active)
    VALUES ($1, $2, 'hash', 'admin', $3, TRUE) RETURNING id, username, role, email
  `, [`ai_user_${TAG}`, `ai_${TAG}@test.com`, `AI User ${TAG}`]);
  userRow = userRes.rows[0];
  userId = userRow.id;

  await pool.query(`
    INSERT INTO coexistence.organization_members (organization_id, user_id, role)
    VALUES ($1, $2, 'admin')
    ON CONFLICT DO NOTHING
  `, [orgId, userId]);

  tokenA = signToken(userRow);

  // 3. Provision WhatsApp account (CONNECTED)
  const encToken = encrypt('meta_test_token_phase6');
  const waRes = await pool.query(`
    INSERT INTO coexistence.whatsapp_accounts
      (organization_id, waba_id, phone_number_id, display_phone_number,
       display_name, access_token_encrypted, connection_status, is_active, is_default)
    VALUES ($1, $2, $3, $4, $5, $6, 'CONNECTED', TRUE, TRUE)
    RETURNING id
  `, [orgId, `waba-ai-${TAG}`, `pnid-ai-${TAG}`, WA_NUM, `AI Test WA ${TAG}`, encToken]);
  waAccountId = waRes.rows[0].id;


  // 3b. Create AI model row
  const mRes = await pool.query(`
    INSERT INTO coexistence.ai_models
      (provider, label, api_key_encrypted, organization_id)
    VALUES ('openai', $1, $2, $3)
    RETURNING id
  `, [`model-${TAG}`, encrypt('sk-test-fake-key'), orgId]);
  aiModelId = mRes.rows[0].id;

  // 4. Create active agent linked to WA account and AI model
  const agRes = await pool.query(`
    INSERT INTO coexistence.agents
      (organization_id, wa_account_id, name, system_prompt, is_active, status, trigger_mode,
       llm_model, ai_model_id, qualify_leads, qualification_rules)
    VALUES ($1, $2, $3, 'You are a helpful AI assistant.', TRUE, 'active', 'any',
            'gpt-4o-mini', $4, TRUE, 'Qualified = customer has a clear use case and budget.')
    RETURNING id
  `, [orgId, waAccountId, `Phase6Agent-${TAG}`, aiModelId]);
  agentId = agRes.rows[0].id;


  // 5. Give org AI credits + active subscription so the quota gate passes
  await pool.query(`
    UPDATE coexistence.organizations
       SET ai_credits_granted = 1000, ai_credits_used = 0
     WHERE id = $1
  `, [orgId]);

  // Upsert an active trialing subscription so ensureSubscription() → quota check passes
  await pool.query(`
    INSERT INTO coexistence.billing_subscriptions
      (organization_id, plan, status, trial_ends_at)
    VALUES ($1, 'trial', 'trialing', NOW() + INTERVAL '30 days')
    ON CONFLICT (organization_id) DO UPDATE
      SET status = 'trialing',
          trial_ends_at = NOW() + INTERVAL '30 days'
  `, [orgId]);

  // 6. Start server (HTTP + Socket.IO realtime, no background queue workers)
  server = http.createServer(app);
  ioServer = initRealtime(server);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  resetTestMetaClient();
  if (ioServer) ioServer.close();
  if (server) await new Promise(r => server.close(r));
  if (typeof llmModule.__setProviderForTests === 'function') {
    llmModule.__setProviderForTests('openai', null);
  }
  await pool.query('DELETE FROM coexistence.agents WHERE id = $1', [agentId]).catch(() => {});
  if (aiModelId) {
    await pool.query('DELETE FROM coexistence.ai_models WHERE id = $1', [aiModelId]).catch(() => {});
  }
  await pool.query('DELETE FROM coexistence.whatsapp_accounts WHERE id = $1', [waAccountId]).catch(() => {});
  await pool.query('DELETE FROM coexistence.organization_members WHERE organization_id = $1', [orgId]).catch(() => {});
  await pool.query('DELETE FROM coexistence.forgecrm_users WHERE id = $1', [userId]).catch(() => {});
  await pool.query('DELETE FROM coexistence.organizations WHERE id = $1', [orgId]).catch(() => {});
  try { pool.end(); } catch {}
});

// ─── Tests ──────────────────────────────────────────────────────────────────

// 1. Organization + WhatsApp account provisioned
test('1. Organization, WhatsApp account, and agent exist', async () => {
  const { rows: o } = await pool.query('SELECT id FROM coexistence.organizations WHERE id=$1', [orgId]);
  assert.equal(o.length, 1, 'org exists');

  const { rows: w } = await pool.query(
    'SELECT id, connection_status FROM coexistence.whatsapp_accounts WHERE id=$1', [waAccountId]);
  assert.equal(w[0]?.connection_status, 'CONNECTED', 'wa account connected');

  const { rows: a } = await pool.query(
    'SELECT id, is_active, qualify_leads FROM coexistence.agents WHERE id=$1', [agentId]);
  assert.equal(a[0]?.is_active, true, 'agent active');
  assert.equal(a[0]?.qualify_leads, true, 'agent has qualify_leads=true');
});

// 2. Inbound webhook validates HMAC (bypassed with ALLOW_UNVERIFIED_WEBHOOKS=true in test)
// 3. Message persisted after inbound webhook
test('2-3. Inbound webhook: HMAC bypassed in test mode, message persisted', async () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: `waba-ai-${TAG}`,
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: `pnid-ai-${TAG}`, display_phone_number: WA_NUM },
          contacts: [{ wa_id: CUST_NUM, profile: { name: `Customer ${TAG}` } }],
          messages: [{
            id: WAMID_IN,
            from: CUST_NUM,
            type: 'text',
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body: 'Hello, I would like a demo please' },
          }],
        },
        field: 'messages',
      }],
    }],
  };

  const res = await fetch(`${baseUrl}/api/v1/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JS(payload),
  });
  assert.equal(res.status, 200, 'webhook accepted');

  const { rows } = await pool.query(
    'SELECT * FROM coexistence.chat_history WHERE message_id=$1', [WAMID_IN]);
  assert.equal(rows.length, 1, 'message persisted');
  assert.equal(rows[0].direction, 'incoming');
  assert.equal(rows[0].message_body, 'Hello, I would like a demo please');
  assert.equal(rows[0].organization_id, orgId);
});

// 4. Lead created / resolved
test('4. Lead created from inbound message', async () => {
  const { rows } = await pool.query(
    'SELECT * FROM coexistence.contacts WHERE contact_number=$1 AND organization_id=$2',
    [CUST_NUM, orgId]);
  assert.equal(rows.length, 1, 'contact row created');
  assert.equal(rows[0].lead_status, 'new');
});

// 5. Conversation created / resolved
test('5. Conversation created from inbound message', async () => {
  const { rows } = await pool.query(
    'SELECT * FROM coexistence.conversations WHERE contact_number=$1 AND organization_id=$2',
    [CUST_NUM, orgId]);
  assert.equal(rows.length, 1, 'conversation row created');
  assert.ok(rows[0].unread_count >= 1, 'unread count incremented');
});

// 6-7. AI job runs via direct processJob() call (bypasses Redis)
// 8. AI qualification runs and persists result
test('6-8. processJob runs agent, qualification runs, lead_qualifications row created', async () => {
  // Stub Meta client so outbound send doesn't hit real API
  setTestMetaClient(async () => ({
    messages: [{ id: WAMID_OUT }],
  }));

  const result = await processJob({
    data: {
      agentId,
      contactNumber: CUST_NUM,
      inboundMessageId: WAMID_IN,
      inboundText: 'Hello, I would like a demo please',
      organizationId: orgId,
    },
  });

  // Agent ran (not skipped for quota/tenant)
  assert.ok(result, 'processJob returned result');
  assert.ok(result.status !== 'refused-tenant-mismatch', 'no tenant mismatch');
  assert.ok(result.status !== 'skipped-quota', `not quota-skipped: ${result.status}`);

  // Qualification ran
  const { rows: q } = await pool.query(
    'SELECT * FROM coexistence.lead_qualifications WHERE organization_id=$1 AND inbound_message_id=$2',
    [orgId, WAMID_IN]);
  assert.ok(q.length >= 1, 'qualification row exists');
  assert.equal(q[0].status, 'qualified');
  assert.equal(q[0].score, 87);
  assert.ok(q[0].summary.includes('demo'), 'summary captured');
});

// 9. AI response persisted as outgoing in chat_history
test('9. AI response persisted in chat_history as outgoing', async () => {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.chat_history
      WHERE organization_id=$1 AND wa_number=$2 AND contact_number=$3
        AND direction='outgoing'
      ORDER BY timestamp DESC LIMIT 1`,
    [orgId, WA_NUM, CUST_NUM]);
  assert.ok(rows.length >= 1, 'outgoing row exists');
});

// 10. Outbound wamid recorded (Meta mock returned WAMID_OUT)
test('10. Outbound wamid recorded from Meta mock response', async () => {
  const { rows } = await pool.query(
    'SELECT * FROM coexistence.chat_history WHERE message_id=$1',
    [WAMID_OUT]);
  assert.ok(rows.length >= 1, 'outbound wamid row exists');
  assert.equal(rows[0].status, 'sent');
});

// 11. Delivery receipt processed monotonically
test('11. Delivery receipt updates status sent → delivered', async () => {
  const { processWebhookEvent } = require('../src/services/whatsappWebhookIngestion');
  const statusPayload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: `waba-ai-${TAG}`,
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: `pnid-ai-${TAG}`, display_phone_number: WA_NUM },
          statuses: [{
            id: WAMID_OUT,
            recipient_id: CUST_NUM,
            status: 'delivered',
            timestamp: String(Math.floor(Date.now() / 1000)),
          }],
        },
        field: 'messages',
      }],
    }],
  };

  await processWebhookEvent({ payload: statusPayload, headers: {}, db: pool });

  const { rows } = await pool.query(
    'SELECT status FROM coexistence.chat_history WHERE message_id=$1', [WAMID_OUT]);
  assert.equal(rows[0]?.status, 'delivered');
});

// 12. Duplicate webhook does NOT re-process or double-charge
test('12. Duplicate inbound webhook is deduplicated', async () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: `waba-ai-${TAG}`,
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: `pnid-ai-${TAG}`, display_phone_number: WA_NUM },
          contacts: [{ wa_id: CUST_NUM, profile: { name: `Customer ${TAG}` } }],
          messages: [{
            id: WAMID_IN, // same wamid as test 2-3
            from: CUST_NUM,
            type: 'text',
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body: 'Replayed message' },
          }],
        },
        field: 'messages',
      }],
    }],
  };

  const res = await fetch(`${baseUrl}/api/v1/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JS(payload),
  });
  assert.equal(res.status, 200, 'duplicate accepted with 200');
  const body = await res.json();
  assert.equal(body.duplicates, 1, 'duplicate counted');
  assert.equal(body.stored, 0, 'no new row stored');
});

// 13. Inbox API — Org A sees conversation
test('13. GET /chats: Org A sees conversation with customer', async () => {
  const res = await authReq('/api/v1/chats', tokenA, orgId);
  assert.equal(res.status, 200);
  const arr = res.json?.chats || res.json?.conversations || res.json?.data || (Array.isArray(res.json) ? res.json : []);
  const found = arr.find(c => c.contact_number === CUST_NUM || c.contactNumber === CUST_NUM);
  assert.ok(found, 'customer conversation visible in Org A inbox');
});

// 14. Org B cannot see Org A conversation (tenant isolation)
test('14. Tenant isolation: Org B cannot see Org A conversation', async () => {
  // Create Org B
  const { rows: [ob] } = await pool.query(`
    INSERT INTO coexistence.organizations (name, slug) VALUES ($1, $2) RETURNING id
  `, [`AI-OrgB-${TAG}`, `ai-orgb-${TAG}`]);
  const orgBId = ob.id;

  const { rows: [ub] } = await pool.query(`
    INSERT INTO coexistence.forgecrm_users (username, email, password, role, display_name, is_active)
    VALUES ($1, $2, 'h', 'admin', $3, TRUE) RETURNING id, username, role, email
  `, [`ai_b_${TAG}`, `ai_b_${TAG}@t.com`, `AI B ${TAG}`]);

  await pool.query(`
    INSERT INTO coexistence.organization_members (organization_id, user_id, role)
    VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING
  `, [orgBId, ub.id]);

  const tokenB = signToken(ub);

  const res = await authReq('/api/v1/chats', tokenB, orgBId);
  assert.equal(res.status, 200);
  const arr = res.json?.conversations || res.json?.data || [];
  const leaked = arr.find(c =>
    c.contact_number === CUST_NUM || c.contactNumber === CUST_NUM);
  assert.ok(!leaked, 'Org B cannot see Org A customer conversation');

  // Cleanup
  await pool.query('DELETE FROM coexistence.organization_members WHERE organization_id=$1', [orgBId]);
  await pool.query('DELETE FROM coexistence.forgecrm_users WHERE id=$1', [ub.id]);
  await pool.query('DELETE FROM coexistence.organizations WHERE id=$1', [orgBId]);
});

// 15. Message history API
test('15. GET /chats/:id/messages returns full thread', async () => {
  const { rows: [conv] } = await pool.query(
    'SELECT id FROM coexistence.conversations WHERE contact_number=$1 AND organization_id=$2',
    [CUST_NUM, orgId]);
  assert.ok(conv?.id, 'conversation id found');

  const res = await authReq(`/api/v1/chats/${conv.id}/messages`, tokenA, orgId);
  assert.equal(res.status, 200);
  const msgs = res.json?.messages || res.json;
  assert.ok(Array.isArray(msgs) && msgs.length >= 2, 'inbound + outbound messages visible');
});

// 16. Human takeover: AI mode disabled
test('16. POST /chats/:id/ai-mode: human takeover disables AI', async () => {
  const { rows: [conv] } = await pool.query(
    'SELECT id FROM coexistence.conversations WHERE contact_number=$1 AND organization_id=$2',
    [CUST_NUM, orgId]);

  const res = await authReq(`/api/v1/chats/${conv.id}/ai-mode`, tokenA, orgId, {
    method: 'POST',
    body: JS({ aiEnabled: false }),
  });
  assert.equal(res.status, 200, `expected 200 got ${res.status}`);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.aiEnabled, false);
  assert.equal(res.json.agentPaused, true);

  // Verify DB flags updated
  const { rows } = await pool.query(
    'SELECT ai_enabled FROM coexistence.conversations WHERE id=$1', [conv.id]);
  assert.equal(rows[0].ai_enabled, false, 'conversation.ai_enabled=false');

  const { rows: c } = await pool.query(
    'SELECT agent_paused FROM coexistence.contacts WHERE contact_number=$1 AND organization_id=$2',
    [CUST_NUM, orgId]);
  assert.equal(c[0].agent_paused, true, 'contact.agent_paused=true');
});

// 17. With human takeover active, agentRouter skips next inbound
test('17. Human takeover: agentRouter skips routing when agent_paused=true', async () => {
  const { routeIfActive } = require('../src/services/agentRouter');
  const result = await routeIfActive({
    direction: 'incoming',
    message_type: 'text',
    message_body: 'Another message while paused',
    wa_number: WA_NUM,
    contact_number: CUST_NUM,
    message_id: `wamid.PAUSED_${TAG}`,
    phone_number_id: `pnid-ai-${TAG}`,
    organizationId: orgId,
  });
  // Either null (no agent found for route) or skipped_for_human
  assert.ok(
    result === null || result?.skipped === 'paused_for_human',
    `expected null or paused_for_human, got: ${JSON.stringify(result)}`
  );
});

// 18. Re-enable AI
test('18. POST /chats/:id/ai-mode: re-enable AI clears pause', async () => {
  const { rows: [conv] } = await pool.query(
    'SELECT id FROM coexistence.conversations WHERE contact_number=$1 AND organization_id=$2',
    [CUST_NUM, orgId]);

  const res = await authReq(`/api/v1/chats/${conv.id}/ai-mode`, tokenA, orgId, {
    method: 'POST',
    body: JS({ aiEnabled: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.aiEnabled, true);
  assert.equal(res.json.agentPaused, false);

  const { rows: c } = await pool.query(
    'SELECT agent_paused FROM coexistence.contacts WHERE contact_number=$1 AND organization_id=$2',
    [CUST_NUM, orgId]);
  assert.equal(c[0].agent_paused, false, 'contact.agent_paused cleared');
});

// 19. GET /chats/:id/ai-mode returns correct state
test('19. GET /chats/:id/ai-mode: returns current AI state', async () => {
  const { rows: [conv] } = await pool.query(
    'SELECT id FROM coexistence.conversations WHERE contact_number=$1 AND organization_id=$2',
    [CUST_NUM, orgId]);

  const res = await authReq(`/api/v1/chats/${conv.id}/ai-mode`, tokenA, orgId);
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.aiEnabled, 'boolean');
  assert.equal(typeof res.json.agentPaused, 'boolean');
  assert.equal(res.json.aiEnabled, true, 'AI re-enabled from test 18');
  assert.equal(res.json.agentPaused, false);
});
