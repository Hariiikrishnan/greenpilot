// Green Pilot Phase 10 automation tests.
//
// Pure unit parts (config validation, trigger matching) ALWAYS run. DB-backed
// parts self-provision and skip without a database. The ONLY stubbed
// boundaries are BullMQ transport (enqueueAutomationRun is captured — the
// worker logic itself runs for real via processJob) and the external LLM
// (test-echo seam, as in Phase 9). No Redis is required: no test walks a live
// WhatsApp send (message sends are covered in testMode + Phase 7/8 suites).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

require('dotenv').config();
process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase10-auto-test-secret';

const svc = require('../src/automation/service');

// --- Pure unit tests (no DB) -------------------------------------------------

test('validateAutomationConfig keeps approved graphs', () => {
  const cfg = {
    nodes: [
      { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'HI' },
      { id: 'c', type: 'condition', matchMode: 'all', rules: [] },
      { id: 'm', type: 'message', messageMode: 'template', templateId: 1 },
      { id: 'd', type: 'delay', delayMode: 'duration', waitValue: '5', waitUnit: 'minutes' },
      { id: 'a', type: 'action', actions: [{ kind: 'Add Tag', value: 'X' }] },
    ],
    edges: [
      { from: 't', to: 'c' }, { from: 'c', to: 'm', fromHandle: 'yes' },
      { from: 'm', to: 'd' }, { from: 'd', to: 'a' },
    ],
  };
  const out = svc.validateAutomationConfig(cfg);
  assert.equal(out.nodes.length, 5, 'approved nodes are KEPT (no linearizer)');
});

test('validateAutomationConfig rejects unsafe/unsupported shapes', () => {
  const base = (trigger, extraNode) => ({
    nodes: [{ id: 't', type: 'trigger', ...trigger }, ...(extraNode ? [extraNode] : [])],
    edges: [],
  });
  assert.throws(() => svc.validateAutomationConfig({ nodes: [], edges: [] }), /trigger/);
  assert.throws(() => svc.validateAutomationConfig(base({ triggerKind: 'webhook' })), /Unsupported trigger/);
  assert.throws(() => svc.validateAutomationConfig(base({ triggerKind: 'apiEvent' })), /Unsupported trigger/);
  assert.throws(() => svc.validateAutomationConfig(base({ triggerKind: 'keyword' })), /keyword/);
  assert.throws(
    () => svc.validateAutomationConfig(base({ triggerKind: 'keyword', keyword: 'HI' }, { id: 'x', type: 'api' })),
    /Unsupported node type/
  );
  assert.throws(
    () => svc.validateAutomationConfig(base({ triggerKind: 'keyword', keyword: 'HI' }, { id: 'x', type: 'subflow' })),
    /Unsupported node type/
  );
  assert.throws(
    () => svc.validateAutomationConfig(base({ triggerKind: 'keyword', keyword: 'HI' },
      { id: 'm', type: 'message', messageMode: 'direct', directType: 'dynamic_api' })),
    /Dynamic API/
  );
  assert.throws(
    () => svc.validateAutomationConfig(base({ triggerKind: 'keyword', keyword: 'HI' },
      { id: 'a', type: 'action', actions: [{ kind: 'Send Email', value: 'x@y.z' }] })),
    /Unsupported action/
  );
});

test('automationMatchesTrigger routes by kind + account filter', () => {
  const auto = (trigger) => ({ id: 1, config: { nodes: [{ id: 't', type: 'trigger', ...trigger }] } });
  const msgEvent = (body, wa = '1555') => ({
    eventType: 'whatsapp.message.received',
    payload: { message_body: body, wa_number: wa },
  });
  assert.equal(svc.automationMatchesTrigger(auto({ triggerKind: 'keyword', keyword: 'HI' }), msgEvent('hi')), true);
  assert.equal(svc.automationMatchesTrigger(auto({ triggerKind: 'keyword', keyword: 'HI' }), msgEvent('bye')), false);
  assert.equal(
    svc.automationMatchesTrigger(
      auto({ triggerKind: 'keyword', keyword: 'HI', triggerAccounts: ['999'] }), msgEvent('hi', '1555')),
    false
  );
  assert.equal(svc.automationMatchesTrigger(auto({ triggerKind: 'message_received' }), msgEvent('anything')), true);
  assert.equal(svc.automationMatchesTrigger(auto({ triggerKind: 'lead_created' }), { eventType: 'lead.created', payload: {} }), true);
  assert.equal(svc.automationMatchesTrigger(auto({ triggerKind: 'lead_qualified' }), { eventType: 'lead.qualified', payload: {} }), true);
  assert.equal(svc.automationMatchesTrigger(auto({ triggerKind: 'lead_status_changed' }), { eventType: 'lead.status.changed', payload: {} }), true);
  assert.equal(svc.automationMatchesTrigger(auto({ triggerKind: 'followup_due' }), { eventType: 'followup.due', payload: {} }), true);
  assert.equal(svc.automationMatchesTrigger(auto({ triggerKind: 'keyword', keyword: 'HI' }), { eventType: 'lead.qualified', payload: {} }), false);
  assert.equal(svc.automationMatchesTrigger({ id: 1, config: { nodes: [] } }, msgEvent('hi')), false);
});

// --- DB-backed tests ----------------------------------------------------------

let pool = null;
let dbAvailable = false;
let server = null;
let base = '';
let sockServer = null;
let sockBase = '';
const TAG = `auto-${Date.now()}`;

// Dedicated number range for this file: node --test runs files concurrently
// against one database, and (wa_number, contact_number) keys are global —
// sharing numbers with tenantIsolation/aiQualification causes cross-file
// races on the same contact rows.
const WA_A = '15550004444';
const WA_B = '15550005555';
const CONTACT = '19998880002';

function jar() {
  const cookies = [];
  return {
    async fetch(path, opts = {}) {
      const res = await globalThis.fetch(`${base}${path}`, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          ...(cookies.length > 0 ? { Cookie: cookies.join('; ') } : {}),
          ...(opts.headers || {}),
        },
        body: opts.body !== undefined ? opts.body : undefined,
      });
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of set) cookies.push(c.split(';')[0]);
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    },
  };
}

const ownerA = jar();
const ownerB = jar();
const memberA = jar();
let orgA = null;
let orgB = null;
let ownerAId = null;
let ownerBId = null;
let accountAId = null;
let accountBId = null;
const autoIds = {};

// Capture BullMQ transport (the ONLY stubbed boundary besides the LLM):
// executions are created for real; jobs are captured, never sent to Redis.
const enqueued = [];
let realEnqueue = null;

let stubCalls = 0;
const { __setProviderForTests, __resetProvidersForTests } = require('../src/llm');

// Tracked sockets: closed in after() even when an assertion fails mid-test,
// so a failed test can never hang the process on a leaked connection.
const openSockets = [];
function sockClient(userId) {
  const { io: ioClient } = require('socket.io-client');
  const token = jwt.sign({ id: userId, username: `u${userId}`, role: 'member' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const c = ioClient(sockBase, { reconnection: false, timeout: 5000, extraHeaders: { cookie: `forgecrm_token=${token}` } });
  openSockets.push(c);
  return c;
}

function waitFor(client, event, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    client.once(event, (...args) => { clearTimeout(t); resolve(args); });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function triggerNode(kind, extra = {}) {
  return { id: 't1', type: 'trigger', triggerKind: kind, keyword: kind === 'keyword' ? (extra.keyword || 'KW') : undefined, ...extra };
}

// Fixture insert via SQL (fast, no HTTP): configs are pre-validated by the
// unit tests + the API create path is covered by dedicated tests. Keeps the
// parallel-suite DB pressure low (flakes observed with 12 sequential creates).
async function mkAuto(orgId, name, nodes, edges) {
  const fullNodes = nodes;
  const fullEdges = edges || (nodes.length > 1
    ? nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id, fromHandle: 'default' }))
    : []);
  const trigger = fullNodes.find((n) => n.type === 'trigger');
  const clean = svc.validateAutomationConfig({ nodes: fullNodes, edges: fullEdges });
  const { rows } = await pool.query(
    `INSERT INTO coexistence.chatbots (name, status, trigger_type, config, organization_id)
     VALUES ($1, 'active', $2, $3, $4) RETURNING id`,
    [`${TAG} ${name}`, trigger?.triggerKind || 'keyword', JSON.stringify(clean), orgId]
  );
  return rows[0].id;
}

before(async () => {
  try {
    pool = require('../src/db');
    await pool.query('SELECT 1');
    const { runMigrations } = require('../src/db/migrate');
    await runMigrations(pool);
    dbAvailable = true;
  } catch {
    return;
  }

  // Capture queue transport before anything can enqueue.
  const autoQ = require('../src/queue/automationQueue');
  realEnqueue = autoQ.enqueueAutomationRun;
  autoQ.enqueueAutomationRun = async (job, opts = {}) => { enqueued.push({ job, opts }); };

  __setProviderForTests('test-echo', {
    runWithTools: async () => {
      stubCalls += 1;
      return {
        finalText: JSON.stringify({
          status: 'qualified', score: 77, intent: 'demo request',
          budget: null, timeline: null, requirements: null,
          summary: 'Customer asked for a demo.',
        }),
        totalInputTokens: 5, totalOutputTokens: 5,
      };
    },
  });

  async function mkUser(name, role = 'admin') {
    const email = `${TAG}-${name}@auto.test`.toLowerCase();
    await pool.query(
      `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role)
       VALUES ($1, $2, 'x', $3, $4) ON CONFLICT (email) DO NOTHING`,
      [`${TAG}-${name}`.toLowerCase(), email, name, role]
    );
    const { rows } = await pool.query(`SELECT id FROM coexistence.forgecrm_users WHERE email = $1`, [email]);
    return { id: rows[0].id, email };
  }
  const ua = await mkUser('ownera');
  const ub = await mkUser('ownerb');
  const um = await mkUser('membera', 'bda_sales');
  ownerAId = ua.id;
  ownerBId = ub.id;

  const { app } = require('../src/index');
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const addr = server.address();
  base = `http://127.0.0.1:${(addr && typeof addr === 'object' ? addr.port : 0)}`;

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(`${TAG}-pw`, 4);
  await pool.query(`UPDATE coexistence.forgecrm_users SET password = $1 WHERE email LIKE '${TAG}-%'`, [hash]);

  let r = await ownerA.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: ua.email, password: `${TAG}-pw` }) });
  assert.equal(r.status, 200, 'ownerA login works');
  r = await ownerB.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: ub.email, password: `${TAG}-pw` }) });
  assert.equal(r.status, 200, 'ownerB login works');
  r = await memberA.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: um.email, password: `${TAG}-pw` }) });
  assert.equal(r.status, 200, 'memberA login works');

  r = await ownerA.fetch('/api/v1/orgs', { method: 'POST', body: JSON.stringify({ name: `${TAG} alpha` }) });
  assert.equal(r.status, 201, 'orgA created');
  orgA = r.body.id;
  r = await ownerB.fetch('/api/v1/orgs', { method: 'POST', body: JSON.stringify({ name: `${TAG} beta` }) });
  assert.equal(r.status, 201, 'orgB created');
  orgB = r.body.id;
  r = await ownerA.fetch(`/api/v1/orgs/${orgA}/members`, {
    method: 'POST', body: JSON.stringify({ email: um.email, role: 'member' }),
  });
  assert.equal(r.status, 201, 'memberA added');

  async function mkAccount(orgId, wa, isDefault = true) {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.whatsapp_accounts
         (display_name, display_phone_number, phone_number_id, waba_id,
          access_token_encrypted, verify_token_encrypted, is_default, is_active, organization_id)
       VALUES ($1, $2, $3, $4, 'enc', 'enc', $5, TRUE, $6) RETURNING id`,
      [`${TAG} ${wa}`, wa, `${TAG}-pn-${wa}`, `${TAG}-waba-${wa}`, isDefault, orgId]
    );
    return rows[0].id;
  }
  accountAId = await mkAccount(orgA, WA_A);
  accountBId = await mkAccount(orgB, WA_B);

  await pool.query(
    `INSERT INTO coexistence.contacts (wa_number, contact_number, organization_id) VALUES ($1, $2, $3)
     ON CONFLICT (wa_number, contact_number) DO NOTHING`,
    [WA_A, CONTACT, orgA]
  );
  await pool.query(`INSERT INTO coexistence.categories (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [`${TAG}-cat`, 'Auto']);
  for (const t of ['TAG_KW', 'TAG_QUAL', 'TAG_STATUS', 'TAG_FOLLOW', 'TAG_DELAY']) {
    await pool.query(`INSERT INTO coexistence.tags (id, name, category_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [`${TAG}-${t}`, `${TAG}-${t}`, `${TAG}-cat`]);
  }
  await pool.query(
    `INSERT INTO coexistence.message_templates (name, category, language, body, status, organization_id)
     VALUES ($1, 'UTILITY', 'en', 'Hello from automation', 'APPROVED', $2)`,
    [`${TAG}-tpl`, orgA]
  );

  // AI fixture for the Invoke-AI-Qualification action test.
  const { encrypt } = require('../src/util/crypto');
  const { rows: mrows } = await pool.query(
    `INSERT INTO coexistence.ai_models (provider, label, api_key_encrypted, organization_id)
     VALUES ('test-echo', $1, $2, NULL) RETURNING id`,
    [`${TAG}-model`, encrypt('test-key')]
  );
  await pool.query(
    `INSERT INTO coexistence.agents
       (name, system_prompt, ai_model_id, llm_model, status, wa_account_id, is_active, organization_id, qualify_leads)
     VALUES ($1, 'You help.', $2, 'test-model', 'active', $3, TRUE, $4, TRUE)`,
    [`${TAG} agent`, mrows[0].id, accountAId, orgA]
  );
  // Agent is resolved by number inside the AI-action test.

  const tag = (name) => ({ id: `a-${name}`, type: 'action', actions: [{ kind: 'Add Tag', value: `${TAG}-${name}` }] });
  autoIds.kw = await mkAuto(orgA, 'kw', [
    triggerNode('keyword', { keyword: 'HELLO' }), tag('TAG_KW'),
  ]);
  autoIds.msg = await mkAuto(orgA, 'msg', [
    triggerNode('message_received'), { id: 'n1', type: 'action', actions: [{ kind: 'Add Note', value: 'auto note' }] },
  ]);
  autoIds.qual = await mkAuto(orgA, 'qual', [
    triggerNode('lead_qualified'), tag('TAG_QUAL'),
  ]);
  autoIds.newlead = await mkAuto(orgA, 'newlead', [
    triggerNode('lead_created'), tag('TAG_KW'),
  ]);
  autoIds.status = await mkAuto(orgA, 'status', [
    triggerNode('lead_status_changed'), tag('TAG_STATUS'),
  ]);
  autoIds.follow = await mkAuto(orgA, 'follow', [
    triggerNode('followup_due'), tag('TAG_FOLLOW'),
  ]);
  autoIds.delay = await mkAuto(orgA, 'delay', [
    triggerNode('keyword', { keyword: 'DELAYME' }),
    { id: 'd1', type: 'delay', delayMode: 'duration', waitValue: '1', waitUnit: 'seconds' },
    tag('TAG_DELAY'),
  ]);
  autoIds.badmsg = await mkAuto(orgA, 'badmsg', [
    triggerNode('keyword', { keyword: 'BADMSG' }),
    { id: 'm1', type: 'message', messageMode: 'template', templateId: 999999, bindings: {} },
  ]);
  autoIds.upd = await mkAuto(orgA, 'upd', [
    triggerNode('keyword', { keyword: 'UPDATEME' }),
    { id: 'a1', type: 'action', actions: [{ kind: 'Update Lead Status', value: 'qualified' }] },
  ]);
  autoIds.ai = await mkAuto(orgA, 'aiact', [
    triggerNode('keyword', { keyword: 'AITHING' }),
    { id: 'a1', type: 'action', actions: [{ kind: 'Invoke AI Qualification', value: '' }] },
  ]);
  const { rows: tplRows } = await pool.query(`SELECT id FROM coexistence.message_templates WHERE name = $1`, [`${TAG}-tpl`]);
  autoIds.msgtest = await mkAuto(orgA, 'msgtest', [
    triggerNode('keyword', { keyword: 'SENDME' }),
    { id: 'm1', type: 'message', messageMode: 'template', templateId: tplRows[0].id, bindings: {} },
  ]);
  autoIds.bkw = await mkAuto(orgB, 'bkw', [
    triggerNode('keyword', { keyword: 'HELLO' }), tag('TAG_KW'),
  ]);

  // Realtime server (membership fakes over the REAL emitter).
  const http = require('http');
  const { initRealtime, resetRealtimeForTests } = require('../src/realtime/socket');
  resetRealtimeForTests();
  sockServer = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  initRealtime(sockServer, {
    deps: {
      loadUser: async (id) => ({ id, role: 'member', is_active: true }),
      listOrgs: async (id) => (
        String(id) === String(ownerAId) ? [{ organization_id: orgA }]
        : String(id) === String(ownerBId) ? [{ organization_id: orgB }] : []
      ),
      log: () => {},
    },
  });
  await new Promise((resolve) => sockServer.listen(0, '127.0.0.1', resolve));
  sockBase = `http://127.0.0.1:${sockServer.address().port}`;
});

after(async () => {
  for (const c of openSockets.splice(0)) {
    try { c.close(); } catch { /* ignore */ }
  }
  try {
    const { closeRealtime, resetRealtimeForTests } = require('../src/realtime/socket');
    await closeRealtime();
    resetRealtimeForTests();
  } catch { /* ignore */ }
  if (sockServer) await new Promise((resolve) => sockServer.close(resolve));
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    const autoQ = require('../src/queue/automationQueue');
    if (realEnqueue) autoQ.enqueueAutomationRun = realEnqueue;
    const { shutdownAutomationQueue } = autoQ;
    const { shutdownSendQueue } = require('../src/queue/sendQueue');
    const { shutdownAgentQueue } = require('../src/queue/agentQueue');
    const { shutdown: shutdownMediaQueue } = require('../src/queue/mediaQueue');
    await shutdownAutomationQueue().catch(() => {});
    await shutdownSendQueue().catch(() => {});
    await shutdownAgentQueue().catch(() => {});
    await shutdownMediaQueue().catch(() => {});
  } catch { /* ignore */ }
  __resetProvidersForTests();
  if (!dbAvailable) return;
  await pool.query(`DELETE FROM coexistence.automation_execution_steps WHERE execution_id IN (SELECT id FROM coexistence.automation_executions WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%'))`);
  await pool.query(`DELETE FROM coexistence.automation_executions WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.follow_ups WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.lead_qualifications WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.lead_notes WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  // 'auto:'-prefixed fallback ids (wamid.* never look like that) cover
  // worker-synthesized identities from message-less test events.
  await pool.query(`DELETE FROM coexistence.ai_usage_ledger WHERE inbound_message_id LIKE '${TAG}-%' OR inbound_message_id LIKE 'auto:%'`);
  await pool.query(`DELETE FROM coexistence.lead_qualifications WHERE inbound_message_id LIKE 'auto:%'`);
  await pool.query(`DELETE FROM coexistence.chat_history WHERE message_id LIKE '${TAG}-%'`);
  await pool.query(`DELETE FROM coexistence.conversations WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  // This file's numbers only (parallel suites own other 1999888* rows).
  await pool.query(`DELETE FROM coexistence.contacts WHERE contact_number IN ('19998880002', '19998880003')`);
  await pool.query(`DELETE FROM coexistence.chatbots WHERE name LIKE '${TAG}%'`);
  await pool.query(`DELETE FROM coexistence.message_templates WHERE name LIKE '${TAG}-%'`);
  await pool.query(`DELETE FROM coexistence.tags WHERE id LIKE '${TAG}-%'`);
  await pool.query(`DELETE FROM coexistence.categories WHERE id LIKE '${TAG}-%'`);
  await pool.query(`DELETE FROM coexistence.agent_runs WHERE agent_id IN (SELECT id FROM coexistence.agents WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.agents WHERE name LIKE '${TAG}%'`);
  await pool.query(`DELETE FROM coexistence.ai_models WHERE label LIKE '${TAG}-%'`);
  await pool.query(`DELETE FROM coexistence.billing_subscriptions WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.whatsapp_accounts WHERE phone_number_id LIKE '${TAG}-%'`);
  await pool.query(`DELETE FROM coexistence.organization_members WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.organizations WHERE name LIKE '${TAG}%'`);
  await pool.query(`DELETE FROM coexistence.forgecrm_users WHERE username LIKE '${TAG}-%'`);
  await pool.end();
});

function wire(name, fn) {
  test(name, async (t) => {
    if (!dbAvailable) {
      t.skip('no database reachable');
      return;
    }
    await fn();
  });
}

async function seedInbound(orgId, wa, contact, msgId, body) {
  await pool.query(
    `INSERT INTO coexistence.chat_history
       (message_id, phone_number_id, wa_number, contact_number, direction,
        message_type, message_body, status, timestamp, organization_id)
     VALUES ($1, $2, $3, $4, 'incoming', 'text', $5, 'received', NOW(), $6)
     ON CONFLICT (message_id) DO NOTHING`,
    [msgId, `${TAG}-pn`, wa, contact, body, orgId]
  );
  await pool.query(
    `INSERT INTO coexistence.conversations
       (organization_id, whatsapp_account_id, wa_number, contact_number, last_message_at, unread_count)
     VALUES ($1, $2, $3, $4, NOW(), 1)
     ON CONFLICT (organization_id, whatsapp_account_id, contact_number)
     DO UPDATE SET last_message_at = NOW(), unread_count = coexistence.conversations.unread_count + 1`,
    [orgId, orgId === orgA ? accountAId : accountBId, wa, contact]
  );
}

async function contactTags(orgId, contact) {
  const { rows } = await pool.query(
    `SELECT tags FROM coexistence.contacts WHERE organization_id = $1 AND contact_number = $2`,
    [orgId, contact]
  );
  return (rows[0]?.tags || []).map((t) => t.name);
}

async function walkExecution(automationId, execution) {
  const { processJob } = require('../src/queue/automationQueue');
  return processJob({ data: {
    organizationId: execution.organization_id,
    automationId, executionId: execution.id, eventId: execution.event_id,
  } });
}

// --- CRUD / authorization ---------------------------------------------------------

wire('automations CRUD stamps org; B cannot see/touch A automations', async () => {
  const list = await ownerB.fetch('/api/v1/automations');
  assert.equal(list.status, 200);
  assert.ok(!list.body.some((a) => String(a.id) === String(autoIds.kw)), 'B list excludes A');
  for (const [method, path, body] of [
    ['GET', `/api/v1/automations/${autoIds.kw}`],
    ['PUT', `/api/v1/automations/${autoIds.kw}`, { name: 'hijack' }],
    ['DELETE', `/api/v1/automations/${autoIds.kw}`],
  ]) {
    const r = await ownerB.fetch(path, body ? { method, body: JSON.stringify(body) } : {});
    assert.equal(r.status, 404, `${method} ${path} → 404`);
  }
  const own = await ownerA.fetch(`/api/v1/automations/${autoIds.kw}`);
  assert.equal(own.status, 200);
  const created = await ownerA.fetch('/api/v1/automations', {
    method: 'POST',
    body: JSON.stringify({
      name: `${TAG} stamp-check`, status: 'draft',
      config: { nodes: [{ id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'ZZ' }], edges: [] },
    }),
  });
  assert.equal(created.status, 201);
  const { rows } = await pool.query(`SELECT organization_id FROM coexistence.chatbots WHERE id = $1`, [created.body.id]);
  assert.equal(String(rows[0].organization_id), String(orgA));
});

wire('member without builder grant cannot manage automations (403)', async () => {
  const r = await memberA.fetch('/api/v1/automations', {
    method: 'POST', body: JSON.stringify({ name: 'x', config: { nodes: [], edges: [] } }),
  });
  assert.equal(r.status, 403);
  const list = await memberA.fetch('/api/v1/automations');
  assert.equal(list.status, 200, 'reads stay member-visible');
});

wire('unsafe configs rejected with 400 (no silent drops)', async () => {
  const bad = [
    { name: 'webhook trigger', config: { nodes: [{ id: 't', type: 'trigger', triggerKind: 'webhook' }], edges: [] } },
    { name: 'api node', config: { nodes: [{ id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'Q' }, { id: 'x', type: 'api' }], edges: [] } },
    { name: 'dynamic api', config: { nodes: [{ id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'Q' }, { id: 'm', type: 'message', messageMode: 'direct', directType: 'dynamic_api' }], edges: [] } },
    { name: 'no trigger', config: { nodes: [{ id: 'm', type: 'message' }], edges: [] } },
  ];
  for (const b of bad) {
    const r = await ownerA.fetch('/api/v1/automations', { method: 'POST', body: JSON.stringify({ ...b, status: 'draft' }) });
    assert.equal(r.status, 400, `${b.name} rejected: ${JSON.stringify(r.body)}`);
  }
});

wire('enable/disable flips status; duplicate copies disabled into acting org', async () => {
  const dis = await ownerA.fetch(`/api/v1/automations/${autoIds.kw}/disable`, { method: 'POST' });
  assert.equal(dis.status, 200);
  assert.equal(dis.body.status, 'inactive');
  const en = await ownerA.fetch(`/api/v1/automations/${autoIds.kw}/enable`, { method: 'POST' });
  assert.equal(en.body.status, 'active');
  const dup = await ownerA.fetch(`/api/v1/automations/${autoIds.kw}/duplicate`, { method: 'POST' });
  assert.equal(dup.status, 201);
  assert.equal(dup.body.status, 'inactive');
});

// --- Event bus: isolation + idempotency ----------------------------------------------

wire('orgB events cannot trigger orgA automations (trigger isolation)', async () => {
  const before = await pool.query(`SELECT COUNT(*)::int AS n FROM coexistence.automation_executions WHERE automation_id = $1`, [autoIds.kw]);
  const created = await svc.emitAutomationEvent(pool, {
    organizationId: orgB, eventType: 'whatsapp.message.received', entityId: 'm-x',
    eventId: `${TAG}-evt-iso`, payload: { message_body: 'HELLO', wa_number: WA_B, contact_number: CONTACT },
  });
  assert.ok(created.length > 0, 'orgB’s own automation fires normally');
  assert.ok(created.every((c) => String(c.automationId) === String(autoIds.bkw)), 'ONLY orgB automations fire');
  const after = await pool.query(`SELECT COUNT(*)::int AS n FROM coexistence.automation_executions WHERE automation_id = $1`, [autoIds.kw]);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

wire('same event twice → one execution (idempotent)', async () => {
  enqueued.length = 0;
  const evt = {
    organizationId: orgA, eventType: 'whatsapp.message.received', entityId: `${TAG}-m-idem`,
    eventId: `${TAG}-evt-idem`, payload: { message_body: 'HELLO', wa_number: WA_A, contact_number: CONTACT },
  };
  // 'HELLO' matches both the keyword automation and the catch-all
  // message_received automation — idempotency holds per (automation, event).
  const first = await svc.emitAutomationEvent(pool, evt);
  assert.equal(first.length, 2);
  assert.ok(first.every((f) => f.duplicate === false));
  const second = await svc.emitAutomationEvent(pool, evt);
  assert.equal(second.length, 2);
  assert.ok(second.every((f) => f.duplicate === true));
  for (const s of second) {
    const match = first.find((f) => f.automationId === s.automationId);
    assert.equal(s.execution.id, match.execution.id);
  }
  assert.equal(enqueued.length, 2, 'duplicates do not re-enqueue');
});

wire('loop guards: visited skip + depth cap', async () => {
  const visited = await svc.emitAutomationEvent(pool, {
    organizationId: orgA, eventType: 'whatsapp.message.received', entityId: `${TAG}-m-v`,
    eventId: `${TAG}-evt-visited`,
    payload: { message_body: 'HELLO', wa_number: WA_A, contact_number: CONTACT },
    visited: [String(autoIds.kw), String(autoIds.msg)],
  });
  assert.equal(visited.length, 0, 'visited automations skipped');
  const deep = await svc.emitAutomationEvent(pool, {
    organizationId: orgA, eventType: 'lead.status.changed', entityId: 'q-x',
    eventId: `${TAG}-evt-deep`, payload: {}, depth: 6,
  });
  assert.equal(deep.length, 0, 'depth > max dropped');
});

// --- Worker: validation ----------------------------------------------------------------

wire('worker refuses forged org jobs without walking', async () => {
  const { processJob } = require('../src/queue/automationQueue');
  const created = await svc.emitAutomationEvent(pool, {
    organizationId: orgA, eventType: 'whatsapp.message.received', entityId: `${TAG}-m-forge`,
    eventId: `${TAG}-evt-forge`, payload: { message_body: 'HELLO', wa_number: WA_A, contact_number: CONTACT },
  });
  const execution = created[0].execution;
  const r = await processJob({ data: {
    organizationId: orgB, automationId: autoIds.kw, executionId: execution.id, eventId: execution.event_id,
  } });
  // The automation-level org check fires first (orgA automation vs orgB job);
  // either refusal proves the forged job never walks.
  assert.ok(['refused-foreign-automation', 'refused-foreign-execution'].includes(r.status), `refused, got ${r.status}`);
  const { rows } = await pool.query(`SELECT status FROM coexistence.automation_executions WHERE id = $1`, [execution.id]);
  assert.equal(rows[0].status, 'queued', 'forged job changed nothing');
});

wire('worker cancels walks for deactivated automations; redelivery is idempotent', async () => {
  const created = await svc.emitAutomationEvent(pool, {
    organizationId: orgA, eventType: 'whatsapp.message.received', entityId: `${TAG}-m-deact`,
    eventId: `${TAG}-evt-deact`, payload: { message_body: 'HELLO', wa_number: WA_A, contact_number: CONTACT },
  });
  const execution = created[0].execution;
  await ownerA.fetch(`/api/v1/automations/${autoIds.kw}/disable`, { method: 'POST' });
  const { processJob } = require('../src/queue/automationQueue');
  const r = await processJob({ data: {
    organizationId: orgA, automationId: autoIds.kw, executionId: execution.id, eventId: execution.event_id,
  } });
  assert.equal(r.status, 'cancelled-inactive');
  await ownerA.fetch(`/api/v1/automations/${autoIds.kw}/enable`, { method: 'POST' });

  // Already-success redelivery completes without re-walking.
  const again = await svc.emitAutomationEvent(pool, {
    organizationId: orgA, eventType: 'whatsapp.message.received', entityId: `${TAG}-m-re`,
    eventId: `${TAG}-evt-re`, payload: { message_body: 'no-match-xyz', wa_number: WA_A, contact_number: CONTACT },
  });
  // (message_received automation matches any inbound → execution created)
  assert.ok(again.length > 0);
  const ex = again.find((e) => e.automationId === autoIds.msg).execution;
  const first = await walkExecution(autoIds.msg, ex);
  assert.equal(first.status, 'success');
  const second = await walkExecution(autoIds.msg, { ...ex, organization_id: orgA });
  assert.equal(second.status, 'already-success');
});

wire('worker rejects jobs missing tenant context', async () => {
  const { processJob } = require('../src/queue/automationQueue');
  await assert.rejects(processJob({ data: {} }), /tenant context/);
});

// --- Worker: walks, retries, delays ---------------------------------------------------------

wire('e2e: inbound → executions → worker walks → CRM + history + socket (A only)', async () => {
  const msgId = `${TAG}-m-e2e`;
  await seedInbound(orgA, WA_A, CONTACT, msgId, 'HELLO need help');
  const a1 = sockClient(ownerAId);
  const b1 = sockClient(ownerBId);
  await Promise.all([waitFor(a1, 'connect'), waitFor(b1, 'connect')]);
  const aEvents = [];
  let bGot = false;
  for (const ev of ['automation-started', 'automation-completed', 'automation-failed']) {
    a1.on(ev, (p) => aEvents.push({ ev, ...p }));
    b1.on(ev, () => { bGot = true; });
  }
  const { handleInboundMessage } = svc;
  const fired = await handleInboundMessage(pool, {
    message_id: msgId, wa_number: WA_A, contact_number: CONTACT,
    phone_number_id: `${TAG}-pn`, message_type: 'text', message_body: 'HELLO need help',
    timestamp: new Date().toISOString(),
  }, orgA);
  assert.ok(fired.length >= 2, `keyword + message automations fired: ${fired.length}`);
  for (const f of fired) {
    const r = await walkExecution(f.automationId, f.execution);
    assert.equal(r.status, 'success', `walk ok: ${JSON.stringify(r)}`);
  }
  const tags = await contactTags(orgA, CONTACT);
  assert.ok(tags.includes(`${TAG}-TAG_KW`), `tag applied: ${tags}`);
  const { rows: notes } = await pool.query(
    `SELECT 1 FROM coexistence.lead_notes WHERE organization_id = $1 AND contact_ref = $2 LIMIT 1`,
    [orgA, CONTACT]
  );
  assert.ok(notes.length >= 1, 'note written');
  const { rows: hist } = await pool.query(
    `SELECT status FROM coexistence.automation_executions
      WHERE organization_id = $1 AND event_id = $2`,
    [orgA, `msg:${msgId}`]
  );
  assert.ok(hist.length >= 1 && hist.every((h) => h.status === 'success'));
  await sleep(300);
  assert.ok(aEvents.some((e) => e.ev === 'automation-started'), 'A got started');
  assert.ok(aEvents.some((e) => e.ev === 'automation-completed'), 'A got completed');
  assert.ok(aEvents.every((e) => e.organizationId === orgA));
  assert.equal(bGot, false, 'B got NOTHING');
  a1.close();
  b1.close();
});

wire('first inbound emits lead.created; second does not', async () => {
  const c2 = '19998880003';
  await pool.query(`INSERT INTO coexistence.contacts (wa_number, contact_number, organization_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [WA_A, c2, orgA]);
  const m1 = `${TAG}-m-new1`;
  await seedInbound(orgA, WA_A, c2, m1, 'first hello');
  await svc.handleInboundMessage(pool, {
    message_id: m1, wa_number: WA_A, contact_number: c2, message_type: 'text', message_body: 'first hello',
  }, orgA);
  const { rows: e1 } = await pool.query(
    `SELECT automation_id FROM coexistence.automation_executions
      WHERE organization_id = $1 AND event_id = $2`,
    [orgA, `lead:${orgA}:${WA_A}:${c2}`]
  );
  assert.ok(e1.some((e) => String(e.automation_id) === String(autoIds.newlead)), 'lead.created execution exists');
  const m2 = `${TAG}-m-new2`;
  await seedInbound(orgA, WA_A, c2, m2, 'second hello');
  await svc.handleInboundMessage(pool, {
    message_id: m2, wa_number: WA_A, contact_number: c2, message_type: 'text', message_body: 'second hello',
  }, orgA);
  const { rows: e2 } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM coexistence.automation_executions
      WHERE organization_id = $1 AND event_id = $2`,
    [orgA, `lead:${orgA}:${WA_A}:${c2}`]
  );
  assert.equal(e2[0].n, e1.length, 'no second lead.created execution');
});

wire('retry: failing node marks execution error (no silent success)', async () => {
  const created = await svc.emitAutomationEvent(pool, {
    organizationId: orgA, eventType: 'whatsapp.message.received', entityId: `${TAG}-m-retry`,
    eventId: `${TAG}-evt-retry`, payload: { message_body: 'BADMSG', wa_number: WA_A, contact_number: CONTACT },
  });
  const target = created.find((e) => e.automationId === autoIds.badmsg);
  assert.ok(target, 'badmsg automation matched BADMSG');
  const { processJob } = require('../src/queue/automationQueue');
  await assert.rejects(
    processJob({ data: {
      organizationId: orgA, automationId: autoIds.badmsg,
      executionId: target.execution.id, eventId: target.execution.event_id,
    } }),
    /template not found/
  );
  const { rows } = await pool.query(`SELECT status, error_message FROM coexistence.automation_executions WHERE id = $1`, [target.execution.id]);
  assert.equal(rows[0].status, 'error');
  assert.ok(rows[0].error_message && !rows[0].error_message.includes(' at '), 'message only, no stack');
});

wire('delay node suspends durably then resumes (tenant revalidated on wake)', async () => {
  enqueued.length = 0;
  const created = await svc.emitAutomationEvent(pool, {
    organizationId: orgA, eventType: 'whatsapp.message.received', entityId: `${TAG}-m-delay`,
    eventId: `${TAG}-evt-delay`, payload: { message_body: 'DELAYME', wa_number: WA_A, contact_number: CONTACT },
  });
  const target = created.find((e) => e.automationId === autoIds.delay);
  assert.ok(target);
  const { processJob } = require('../src/queue/automationQueue');
  const r1 = await processJob({ data: {
    organizationId: orgA, automationId: autoIds.delay,
    executionId: target.execution.id, eventId: target.execution.event_id,
  } });
  assert.equal(r1.status, 'delayed');
  assert.equal(r1.delayMs, 1000);
  const delayedJob = enqueued.find((e) => e.job.resumeNodeId);
  assert.ok(delayedJob, 'resume requeued');
  assert.equal(delayedJob.opts.delayMs, 1000);
  assert.equal(delayedJob.job.organizationId, orgA, 'tenant context preserved');
  const r2 = await processJob({ data: {
    organizationId: orgA, automationId: autoIds.delay,
    executionId: target.execution.id, eventId: target.execution.event_id,
    resumeNodeId: delayedJob.job.resumeNodeId,
  } });
  assert.equal(r2.status, 'success');
  const tags = await contactTags(orgA, CONTACT);
  assert.ok(tags.includes(`${TAG}-TAG_DELAY`));
});

wire('update-lead-status cascades with depth+1 (loop-safe chain)', async () => {
  await pool.query(
    `INSERT INTO coexistence.lead_qualifications
       (organization_id, wa_number, contact_number, inbound_message_id, status, summary)
     VALUES ($1, $2, $3, $4, 'needs-more-information', 'seed')`,
    [orgA, WA_A, CONTACT, `${TAG}-m-cascade`]
  );
  const created = await svc.emitAutomationEvent(pool, {
    organizationId: orgA, eventType: 'whatsapp.message.received', entityId: `${TAG}-m-upd`,
    eventId: `${TAG}-evt-upd`, payload: { message_body: 'UPDATEME', wa_number: WA_A, contact_number: CONTACT },
  });
  const target = created.find((e) => e.automationId === autoIds.upd);
  assert.ok(target);
  const r = await walkExecution(autoIds.upd, target.execution);
  assert.equal(r.status, 'success');
  const { rows: after } = await pool.query(
    `SELECT status FROM coexistence.lead_qualifications WHERE organization_id = $1 AND wa_number = $2 AND contact_number = $3 ORDER BY evaluated_at DESC LIMIT 1`,
    [orgA, WA_A, CONTACT]
  );
  assert.equal(after[0].status, 'qualified');
  const { rows: chained } = await pool.query(
    `SELECT depth, trigger_type FROM coexistence.automation_executions
      WHERE organization_id = $1 AND trigger_type = 'lead.status.changed'
      ORDER BY created_at DESC LIMIT 1`,
    [orgA]
  );
  assert.equal(chained.length, 1, 'status.changed execution created');
  assert.equal(chained[0].depth, 1, 'depth incremented');
});

wire('AI action runs Phase 9 qualification (quota-gated, ledgered)', async () => {
  const before = stubCalls;
  const created = await svc.emitAutomationEvent(pool, {
    organizationId: orgA, eventType: 'whatsapp.message.received', entityId: `${TAG}-m-ai`,
    eventId: `${TAG}-evt-ai`,
    payload: { message_id: `${TAG}-m-ai`, message_body: 'AITHING', wa_number: WA_A, contact_number: CONTACT },
  });
  const target = created.find((e) => e.automationId === autoIds.ai);
  assert.ok(target);
  const r = await walkExecution(autoIds.ai, target.execution);
  assert.equal(r.status, 'success');
  assert.equal(stubCalls, before + 1, 'model invoked once');
  const { rows: q } = await pool.query(
    `SELECT status FROM coexistence.lead_qualifications
      WHERE organization_id = $1 AND inbound_message_id = $2`,
    [orgA, `${TAG}-m-ai`]
  );
  assert.equal(q.length, 1, 'qualification persisted via automation');
  const { rows: ledger } = await pool.query(
    `SELECT cost_credits FROM coexistence.ai_usage_ledger
      WHERE organization_id = $1 AND inbound_message_id = $2`,
    [orgA, `${TAG}-m-ai#qualify`]
  );
  assert.equal(ledger.length, 1, 'AI usage charged through Phase 8 ledger');
});

wire('follow-up sweeper claims due rows and fires (future untouched)', async () => {
  const past = new Date(Date.now() - 60000).toISOString();
  const future = new Date(Date.now() + 3600000).toISOString();
  await pool.query(
    `INSERT INTO coexistence.follow_ups (organization_id, contact_ref, due_at, status)
     VALUES ($1, $2, $3, 'pending'), ($1, $2, $4, 'pending')`,
    [orgA, CONTACT, past, future]
  );
  const { sweepDueFollowups } = svc;
  const r = await sweepDueFollowups(pool);
  assert.equal(r.claimed, 1);
  const { rows: tagged } = await pool.query(
    `SELECT status FROM coexistence.follow_ups WHERE organization_id = $1 AND contact_ref = $2 ORDER BY due_at`,
    [orgA, CONTACT]
  );
  assert.deepEqual(tagged.map((x) => x.status), ['done', 'pending']);
  const { rows: execs } = await pool.query(
    `SELECT id FROM coexistence.automation_executions
      WHERE organization_id = $1 AND automation_id = $2 AND trigger_type = 'followup.due'
      ORDER BY created_at DESC LIMIT 1`,
    [orgA, autoIds.follow]
  );
  assert.equal(execs.length, 1, 'followup.due execution created');
  const w = await walkExecution(autoIds.follow, { ...execs[0], organization_id: orgA, event_id: 'x' });
  assert.equal(w.status, 'success');
  const tags = await contactTags(orgA, CONTACT);
  assert.ok(tags.includes(`${TAG}-TAG_FOLLOW`));
});

// --- Manual test run ------------------------------------------------------------------

wire('test-run simulates everything: steps returned, zero side effects', async () => {
  const { orgQuotaSnapshot } = require('../src/billing/quotas');
  const s0 = await orgQuotaSnapshot(pool, orgA);
  const tagsBefore = await contactTags(orgA, CONTACT);
  const r = await ownerA.fetch(`/api/v1/automations/${autoIds.kw}/test-run`, {
    method: 'POST', body: JSON.stringify({ contactNumber: CONTACT, waNumber: WA_A, messageText: 'HELLO test' }),
  });
  assert.equal(r.status, 200, `test-run ok: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.simulated, true);
  assert.ok(r.body.execution.test_mode, 'test mode flagged');
  // Simulated markers live on action RESULTS (step rows keep the CHECK-safe
  // 'success' status).
  const simulated = (r.body.steps || []).some((s) =>
    (s.output_data?.results || []).some((x) => x.status === 'simulated')
  );
  assert.ok(simulated, 'simulated action results present');
  const tagsAfter = await contactTags(orgA, CONTACT);
  assert.deepEqual(tagsAfter.sort(), tagsBefore.sort(), 'no tag writes in test mode');
  const s1 = await orgQuotaSnapshot(pool, orgA);
  assert.equal(s1.used, s0.used, 'no quota consumed in test mode');
  const b = await ownerB.fetch(`/api/v1/automations/${autoIds.kw}/test-run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(b.status, 404, 'B cannot test-run A automation');
});

// --- History / cancel --------------------------------------------------------------------

wire('execution history is org-scoped; cancel semantics hold', async () => {
  const created = await svc.emitAutomationEvent(pool, {
    organizationId: orgA, eventType: 'whatsapp.message.received', entityId: `${TAG}-m-hist`,
    eventId: `${TAG}-evt-hist`, payload: { message_body: 'HELLO', wa_number: WA_A, contact_number: CONTACT },
  });
  const execution = created[0].execution;
  const bGet = await ownerB.fetch(`/api/executions/${execution.id}`);
  assert.equal(bGet.status, 404);
  const bList = await ownerB.fetch(`/api/v1/automations/${autoIds.bkw}/executions`);
  assert.equal(bList.status, 200);
  assert.ok(!bList.body.executions.some((e) => String(e.id) === String(execution.id)));
  const aGet = await ownerA.fetch(`/api/executions/${execution.id}`);
  assert.equal(aGet.status, 200);
  assert.ok(Array.isArray(aGet.body.steps));

  const cancel = await ownerA.fetch(`/api/executions/${execution.id}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.status, 'cancelled');
  const again = await ownerA.fetch(`/api/executions/${execution.id}/cancel`, { method: 'POST' });
  assert.equal(again.status, 409);
  const bCancel = await ownerB.fetch(`/api/executions/${execution.id}/cancel`, { method: 'POST' });
  assert.equal(bCancel.status, 404);
});

// --- WhatsApp action isolation ---------------------------------------------------------------

wire('message nodes refuse foreign accounts; testMode never sends', async () => {
  // Cross-org send attempt: automation in orgB context using orgA's account.
  const created = await svc.emitAutomationEvent(pool, {
    organizationId: orgB, eventType: 'whatsapp.message.received', entityId: `${TAG}-m-wa`,
    eventId: `${TAG}-evt-wa`, payload: { message_body: 'HELLO', wa_number: WA_B, contact_number: CONTACT },
  });
  assert.ok(created.length >= 0);
  // Direct engine-level proof with orgB context against an orgA-bound template:
  const { executeAutomation } = require('../src/engine/automationEngine');
  const client = await pool.connect();
  try {
    const { rows: tplRows } = await pool.query(`SELECT id FROM coexistence.message_templates WHERE name = $1`, [`${TAG}-tpl`]);
    const execution = await executeAutomation(client, {
      id: autoIds.msgtest, organization_id: orgA,
      config: { nodes: [
        { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'SENDME' },
        { id: 'm', type: 'message', messageMode: 'template', templateId: tplRows[0].id, bindings: {}, whatsappAccountId: accountAId },
      ], edges: [{ from: 't', to: 'm' }] },
    }, {
      contact_number: CONTACT, message_body: 'SENDME',
      trigger_type: 'keyword',
      trigger_data: { message_id: `${TAG}-m-wax`, wa_number: WA_A },
      organization_id: orgB, // forged context: B executing A's flow
      event_id: `${TAG}-evt-wax`,
    });
    // executeAutomation returns the as-created row; the terminal status is
    // on the re-read row (updateExecutionStatus runs after the walk). The
    // throwing message node logs no step of its own — the proof is the
    // terminal error naming the tenant boundary.
    const { rows: fin } = await pool.query(
      `SELECT status, error_message FROM coexistence.automation_executions WHERE id = $1`, [execution.id]
    );
    assert.equal(fin[0].status, 'error');
    assert.ok(/organization/i.test(fin[0].error_message || ''), `failed closed at tenant boundary: ${fin[0].error_message}`);
  } finally {
    client.release();
  }

  // TestMode never enqueues: run the SAME flow in test mode, assert simulated.
  const client2 = await pool.connect();
  try {
    const { rows: tplRows } = await pool.query(`SELECT id FROM coexistence.message_templates WHERE name = $1`, [`${TAG}-tpl`]);
    const { executeAutomation: exec2 } = require('../src/engine/automationEngine');
    const execution = await exec2(client2, {
      id: autoIds.msgtest, organization_id: orgA,
      config: { nodes: [
        { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'SENDME' },
        { id: 'm', type: 'message', messageMode: 'template', templateId: tplRows[0].id, bindings: {}, whatsappAccountId: accountAId },
      ], edges: [{ from: 't', to: 'm' }] },
    }, {
      contact_number: CONTACT, message_body: 'SENDME', trigger_type: 'keyword',
      trigger_data: { message_id: `${TAG}-m-watest`, wa_number: WA_A },
      organization_id: orgA, test_mode: true, event_id: `${TAG}-evt-watest`,
    });
    const { rows: steps } = await pool.query(
      `SELECT status, output_data FROM coexistence.automation_execution_steps WHERE execution_id = $1 AND node_type = 'message'`,
      [execution.id]
    );
    assert.ok(steps.some((s) => s.status === 'success' && s.output_data?.simulated), 'test send simulated');
    const { rows: sends } = await pool.query(
      `SELECT 1 FROM coexistence.chat_history WHERE message_id LIKE '${TAG}-m-watest%' LIMIT 1`
    );
    assert.equal(sends.length, 0, 'no outbound row in test mode');
  } finally {
    client2.release();
  }
});

