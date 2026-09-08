// Green Pilot Phase 11 CRM tests.
//
// Pure unit parts (status enum) ALWAYS run. DB-backed parts self-provision
// (migrations incl. 069) and skip without a database. BullMQ transport is
// captured (patched enqueueAutomationRun — worker logic runs for real via
// processJob); no Redis is required. Own phone-number range (parallel files
// share one DB and (wa,contact) keys are global).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

require('dotenv').config();
process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase11-crm-test-secret';

const { LEAD_STATUSES } = require('../src/crm/service');

test('canonical lead statuses are the approved vocabulary', () => {
  for (const s of ['new', 'contacted', 'qualified', 'unqualified', 'needs-more-information', 'won', 'lost']) {
    assert.ok(LEAD_STATUSES.includes(s), s);
  }
  assert.ok(!LEAD_STATUSES.includes('advertising-qualified'));
});

let pool = null;
let dbAvailable = false;
let server = null;
let base = '';
let sockServer = null;
let sockBase = '';
const TAG = `crm-${Date.now()}`;

// Dedicated range (see header note).
const WA_A = '15550008888';
const CONTACT = '19998882222';
const CONTACT2 = '19998883333';

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
let memberAId = null;
let pipeA = null;
let pipeB = null;
let stagesA = [];
let leadId = null;

const enqueued = [];
let realEnqueue = null;
const openSockets = [];
let dealWatchId = null;

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

  const autoQ = require('../src/queue/automationQueue');
  realEnqueue = autoQ.enqueueAutomationRun;
  autoQ.enqueueAutomationRun = async (job, opts = {}) => { enqueued.push({ job, opts }); };

  async function mkUser(name, role = 'admin') {
    const email = `${TAG}-${name}@crm.test`.toLowerCase();
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
  memberAId = um.id;

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

  await pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (display_name, display_phone_number, phone_number_id, waba_id,
        access_token_encrypted, verify_token_encrypted, is_default, is_active, organization_id)
     VALUES ($1, $2, $3, $4, 'enc', 'enc', TRUE, TRUE, $5)`,
    [`${TAG} wa`, WA_A, `${TAG}-pn-a`, `${TAG}-waba-a`, orgA]
  );

  r = await ownerA.fetch('/api/v1/pipelines', { method: 'POST', body: JSON.stringify({ name: `${TAG} sales` }) });
  assert.equal(r.status, 201, 'pipeA created');
  pipeA = r.body.id;
  stagesA = r.body.stages;
  assert.ok(stagesA.length >= 2, 'default stages seeded');
  r = await ownerB.fetch('/api/v1/pipelines', { method: 'POST', body: JSON.stringify({ name: `${TAG} beta pipe` }) });
  assert.equal(r.status, 201, 'pipeB created');
  pipeB = r.body.id;

  r = await ownerA.fetch('/api/v1/leads', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT, name: `${TAG} Asha` }),
  });
  assert.equal(r.status, 201, 'lead created');
  leadId = r.body.id;

  // Deal-move watcher: proves CRM operations feed the automation bus.
  r = await ownerA.fetch('/api/v1/automations', {
    method: 'POST',
    body: JSON.stringify({
      name: `${TAG} dealwatch`, status: 'active',
      config: {
        nodes: [
          { id: 't', type: 'trigger', triggerKind: 'lead_status_changed' },
          { id: 'a', type: 'action', actions: [{ kind: 'Add Note', value: 'deal moved' }] },
        ],
        edges: [{ from: 't', to: 'a' }],
      },
    }),
  });
  assert.equal(r.status, 201, 'dealwatch automation created');
  dealWatchId = r.body.id;

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
  if (!dbAvailable) return;
  await pool.query(`DELETE FROM coexistence.automation_execution_steps WHERE execution_id IN (SELECT id FROM coexistence.automation_executions WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%'))`);
  await pool.query(`DELETE FROM coexistence.automation_executions WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.lead_activities WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.lead_notes WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.lead_calls WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.follow_ups WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.lead_qualifications WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.ai_usage_ledger WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.chat_history WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.conversations WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.deals WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.chatbots WHERE name LIKE '${TAG}%'`);
  await pool.query(`DELETE FROM coexistence.pipeline_stages WHERE pipeline_id IN (SELECT id FROM coexistence.pipelines WHERE name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.pipelines WHERE name LIKE '${TAG}%'`);
  // This file's numbers only (bulk 19998884000-14 + c3 share the 19998884* prefix;
  // parallel suites own other 1999888* rows).
  await pool.query(`DELETE FROM coexistence.contacts WHERE contact_number LIKE '19998884%' OR contact_number IN ('${CONTACT}', '${CONTACT2}')`);
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

// --- Lead CRUD / isolation ------------------------------------------------------------

wire('lead CRUD: create/get/by-contact/delete + duplicate 409', async () => {
  const created = await ownerA.fetch('/api/v1/leads', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT2, name: 'Second' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.leadStatus, 'new');
  const dup = await ownerA.fetch('/api/v1/leads', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT2 }),
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.leadId, created.body.id);
  const get = await ownerA.fetch(`/api/v1/leads/${created.body.id}`);
  assert.equal(get.status, 200);
  assert.equal(get.body.contactNumber, CONTACT2);
  const byc = await ownerA.fetch(`/api/v1/leads/by-contact?waNumber=${WA_A}&contactNumber=${CONTACT2}`);
  assert.equal(byc.status, 200);
  assert.equal(byc.body.id, created.body.id);
  const del = await ownerA.fetch(`/api/v1/leads/${created.body.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const gone = await ownerA.fetch(`/api/v1/leads/${created.body.id}`);
  assert.equal(gone.status, 404);
});

wire('lead isolation: B cannot see/touch A leads; forged org 403', async () => {
  for (const [method, path, body] of [
    ['GET', `/api/v1/leads/${leadId}`],
    ['DELETE', `/api/v1/leads/${leadId}`],
    ['PATCH', `/api/v1/leads/${leadId}/status`, { status: 'won' }],
    ['PATCH', `/api/v1/leads/${leadId}/stage`, { stageId: stagesA[0].id }],
    ['PATCH', `/api/v1/leads/${leadId}/assign`, { userId: memberAId }],
  ]) {
    const r = await ownerB.fetch(path, body ? { method, body: JSON.stringify(body) } : {});
    assert.equal(r.status, 404, `${method} ${path} → 404`);
  }
  const list = await ownerB.fetch('/api/v1/leads');
  assert.equal(list.status, 200);
  assert.ok(!list.body.data.some((l) => String(l.id) === String(leadId)));
  const forged = await ownerB.fetch(`/api/v1/leads/${leadId}`, { headers: { 'X-Org-Id': orgA } });
  assert.equal(forged.status, 403);
  const byc = await ownerB.fetch(`/api/v1/leads/by-contact?waNumber=${WA_A}&contactNumber=${CONTACT}`);
  assert.equal(byc.status, 404);
});

// --- Status / stage / assignment -----------------------------------------------------------

wire('status change: validates, audits, emits bus + socket', async () => {
  const a1 = sockClient(ownerAId);
  const b1 = sockClient(ownerBId);
  await Promise.all([waitFor(a1, 'connect'), waitFor(b1, 'connect')]);
  let aGot = null;
  let bGot = false;
  a1.on('lead-status-changed', (p) => { aGot = p; });
  b1.on('lead-status-changed', () => { bGot = true; });

  const bad = await ownerA.fetch(`/api/v1/leads/${leadId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'rich' }) });
  assert.equal(bad.status, 400);
  const r = await ownerA.fetch(`/api/v1/leads/${leadId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'contacted' }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.leadStatus, 'contacted');
  assert.equal(r.body.changed, true);
  const same = await ownerA.fetch(`/api/v1/leads/${leadId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'contacted' }) });
  assert.equal(same.body.changed, false, 'repeat set is a no-op');
  const { rows: acts } = await pool.query(
    `SELECT kind FROM coexistence.lead_activities WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, [orgA]
  );
  assert.ok(['status', 'created'].includes(acts[0].kind));
  await sleep(300);
  assert.ok(aGot && String(aGot.contactNumber).replace(/\D/g, '') === CONTACT.replace(/\D/g, ''), 'A got lead-status-changed');
  assert.equal(bGot, false, 'B got NOTHING');
  a1.close();
  b1.close();
});

wire('stage change: validates pipeline ownership; null clears', async () => {
  const foreignStage = await pool.query(
    `SELECT s.id FROM coexistence.pipeline_stages s JOIN coexistence.pipelines p ON p.id = s.pipeline_id WHERE p.id = $1 ORDER BY s.position LIMIT 1`,
    [pipeB]
  );
  const bad = await ownerA.fetch(`/api/v1/leads/${leadId}/stage`, { method: 'PATCH', body: JSON.stringify({ stageId: foreignStage.rows[0].id }) });
  assert.equal(bad.status, 404, 'foreign stage rejected');
  const ok = await ownerA.fetch(`/api/v1/leads/${leadId}/stage`, { method: 'PATCH', body: JSON.stringify({ stageId: stagesA[0].id }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.pipelineStageId, stagesA[0].id);
  const clear = await ownerA.fetch(`/api/v1/leads/${leadId}/stage`, { method: 'PATCH', body: JSON.stringify({ stageId: null }) });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.pipelineStageId, null);
});

wire('assignment: member-only, foreign rejected, clear works', async () => {
  const r = await ownerA.fetch(`/api/v1/leads/${leadId}/assign`, { method: 'PATCH', body: JSON.stringify({ userId: memberAId }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.assignedUserId, memberAId);
  const foreign = await ownerA.fetch(`/api/v1/leads/${leadId}/assign`, { method: 'PATCH', body: JSON.stringify({ userId: ownerBId }) });
  assert.equal(foreign.status, 400, 'orgB user rejected');
  const ghost = await ownerA.fetch(`/api/v1/leads/${leadId}/assign`, { method: 'PATCH', body: JSON.stringify({ userId: 999999 }) });
  assert.equal(ghost.status, 400, 'unknown user rejected');
  const clear = await ownerA.fetch(`/api/v1/leads/${leadId}/assign`, { method: 'PATCH', body: JSON.stringify({ userId: null }) });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.assignedUserId, null);
});

// --- Pipelines / deals isolation ---------------------------------------------------------------

wire('pipelines are org-scoped end to end', async () => {
  const bList = await ownerB.fetch('/api/v1/pipelines');
  assert.equal(bList.status, 200);
  assert.ok(!bList.body.some((p) => String(p.id) === String(pipeA)));
  for (const [method, path, body] of [
    ['PUT', `/api/v1/pipelines/${pipeA}`, { name: 'hijack' }],
    ['DELETE', `/api/v1/pipelines/${pipeA}`],
    ['POST', `/api/v1/pipelines/${pipeA}/stages`, { name: 'X' }],
  ]) {
    const r = await ownerB.fetch(path, { method, body: body ? JSON.stringify(body) : undefined });
    assert.equal(r.status, 404, `${method} ${path} → 404`);
  }
  const put = await ownerA.fetch(`/api/v1/pipelines/${pipeA}`, { method: 'PUT', body: JSON.stringify({ name: `${TAG} sales renamed` }) });
  assert.equal(put.status, 200);
  assert.ok(Array.isArray(put.body.stages) && put.body.stages.length > 0, 'PUT shape includes stages');
});

wire('deals enforce org integrity (pipeline, stage, contact, assignee)', async () => {
  const bStage = await pool.query(
    `SELECT s.id FROM coexistence.pipeline_stages s JOIN coexistence.pipelines p ON p.id = s.pipeline_id WHERE p.id = $1 LIMIT 1`,
    [pipeB]
  );
  const badStage = await ownerA.fetch('/api/v1/deals', {
    method: 'POST',
    body: JSON.stringify({ pipelineId: pipeA, stageId: bStage.rows[0].id, title: 'evil' }),
  });
  assert.equal(badStage.status, 400, 'foreign stage rejected');
  const badPipe = await ownerB.fetch('/api/v1/deals', {
    method: 'POST', body: JSON.stringify({ pipelineId: pipeA, title: 'evil' }),
  });
  assert.equal(badPipe.status, 404, 'foreign pipeline rejected');
  const badAssign = await ownerA.fetch('/api/v1/deals', {
    method: 'POST',
    body: JSON.stringify({ pipelineId: pipeA, title: 'evil', assignedUserId: ownerBId }),
  });
  assert.equal(badAssign.status, 400, 'foreign assignee rejected');
  const ok = await ownerA.fetch('/api/v1/deals', {
    method: 'POST',
    body: JSON.stringify({
      pipelineId: pipeA, title: `${TAG} deal`, value: 50000,
      contactWaNumber: WA_A, contactNumber: CONTACT, assignedUserId: memberAId,
    }),
  });
  assert.equal(ok.status, 201, `deal created: ${JSON.stringify(ok.body)}`);
  assert.equal(ok.body.assignedUserId, memberAId);
  // Linked contact mirrored to the assignee.
  const { rows: cc } = await pool.query(
    `SELECT assigned_user_id FROM coexistence.contacts WHERE organization_id = $1 AND contact_number = $2`,
    [orgA, CONTACT]
  );
  assert.equal(String(cc[0].assigned_user_id), String(memberAId));
  return ok.body.id;
});

wire('deal move: derived status, idempotent same-stage, member rules, bus event', async () => {
  const created = await ownerA.fetch('/api/v1/deals', {
    method: 'POST', body: JSON.stringify({ pipelineId: pipeA, title: `${TAG} mover` }),
  });
  const dealId = created.body.id;
  const wonStage = stagesA.find((s) => s.stageType === 'won');
  assert.ok(wonStage, 'won stage exists');
  const moved = await ownerA.fetch(`/api/v1/deals/${dealId}/move`, { method: 'POST', body: JSON.stringify({ stageId: wonStage.id }) });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.status, 'won');
  assert.ok(moved.body.wonAt, 'won_at stamped');
  const same = await ownerA.fetch(`/api/v1/deals/${dealId}/move`, { method: 'POST', body: JSON.stringify({ stageId: wonStage.id }) });
  assert.equal(same.status, 200);
  assert.equal(same.body.position, moved.body.position, 'same-stage move is a no-op');
  const bStage = await pool.query(
    `SELECT s.id FROM coexistence.pipeline_stages s JOIN coexistence.pipelines p ON p.id = s.pipeline_id WHERE p.id = $1 LIMIT 1`,
    [pipeB]
  );
  const foreign = await ownerA.fetch(`/api/v1/deals/${dealId}/move`, { method: 'POST', body: JSON.stringify({ stageId: bStage.rows[0].id }) });
  assert.equal(foreign.status, 400);
  const bMove = await ownerB.fetch(`/api/v1/deals/${dealId}/move`, { method: 'POST', body: JSON.stringify({ stageId: stagesA[0].id }) });
  assert.equal(bMove.status, 404);
  // Member moves own deal, not others'.
  const own = await ownerA.fetch('/api/v1/deals', {
    method: 'POST', body: JSON.stringify({ pipelineId: pipeA, title: `${TAG} member deal`, assignedUserId: memberAId }),
  });
  const mMove = await memberA.fetch(`/api/v1/deals/${own.body.id}/move`, { method: 'POST', body: JSON.stringify({ stageId: stagesA[0].id }) });
  assert.equal(mMove.status, 200);
  const otherMove = await memberA.fetch(`/api/v1/deals/${dealId}/move`, { method: 'POST', body: JSON.stringify({ stageId: stagesA[0].id }) });
  assert.equal(otherMove.status, 403);
  // Bus event for the real move (deterministic id) picked up by the watcher.
  const { rows: ev } = await pool.query(
    `SELECT automation_id, depth FROM coexistence.automation_executions
      WHERE organization_id = $1 AND event_id = $2`,
    [orgA, `dealstage:${dealId}:${wonStage.id}`]
  );
  assert.equal(ev.length, 1, 'deal move emitted exactly one bus event');
  assert.equal(String(ev[0].automation_id), String(dealWatchId));
  assert.equal(ev[0].depth, 0);
  assert.ok(enqueued.some((e) => String(e.job.automationId) === String(dealWatchId)), 'watcher job enqueued');
});

// --- Notes / calls ----------------------------------------------------------------------

wire('notes + calls CRUD with cross-tenant rejection', async () => {
  const note = await ownerA.fetch('/api/v1/crm/notes', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT, body: 'Called twice' }),
  });
  assert.equal(note.status, 201);
  const list = await ownerA.fetch(`/api/v1/crm/notes?waNumber=${WA_A}&contactNumber=${CONTACT}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.some((n) => n.body === 'Called twice'));
  const upd = await ownerA.fetch(`/api/v1/crm/notes/${note.body.id}`, { method: 'PUT', body: JSON.stringify({ body: 'Called thrice' }) });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.body, 'Called thrice');
  const bUpd = await ownerB.fetch(`/api/v1/crm/notes/${note.body.id}`, { method: 'PUT', body: JSON.stringify({ body: 'hijack' }) });
  assert.equal(bUpd.status, 404);
  const bDel = await ownerB.fetch(`/api/v1/crm/notes/${note.body.id}`, { method: 'DELETE' });
  assert.equal(bDel.status, 404);
  const del = await ownerA.fetch(`/api/v1/crm/notes/${note.body.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);

  const call = await ownerA.fetch('/api/v1/crm/calls', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT, outcome: 'Connected', notes: 'Wants demo' }),
  });
  assert.equal(call.status, 201);
  const calls = await ownerA.fetch(`/api/v1/crm/calls?waNumber=${WA_A}&contactNumber=${CONTACT}`);
  assert.ok(calls.body.some((c) => c.outcome === 'Connected'));
  const bCall = await ownerB.fetch(`/api/v1/crm/calls?waNumber=${WA_A}&contactNumber=${CONTACT}`);
  assert.equal(bCall.status, 200);
  assert.equal(bCall.body.length, 0, 'B sees no calls');
  const delCall = await ownerA.fetch(`/api/v1/crm/calls/${call.body.id}`, { method: 'DELETE' });
  assert.equal(delCall.status, 200);
});

// --- Follow-ups ------------------------------------------------------------------------------

wire('follow-up lifecycle: create/validate/complete/cancel + isolation', async () => {
  const past = await ownerA.fetch('/api/v1/crm/followups', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT, dueAt: '2000-01-01T00:00:00Z' }),
  });
  assert.equal(past.status, 400, 'past due rejected');
  const badUser = await ownerA.fetch('/api/v1/crm/followups', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT, dueAt: '2030-01-01T00:00:00Z', assignedTo: ownerBId }),
  });
  assert.equal(badUser.status, 400, 'foreign assignee rejected');
  const created = await ownerA.fetch('/api/v1/crm/followups', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT, dueAt: '2d', assignedTo: memberAId }),
  });
  assert.equal(created.status, 201, `followup created: ${JSON.stringify(created.body)}`);
  const list = await ownerA.fetch(`/api/v1/crm/followups?waNumber=${WA_A}&contactNumber=${CONTACT}&status=pending`);
  assert.ok(list.body.data.some((f) => String(f.id) === String(created.body.id)));
  const bList = await ownerB.fetch(`/api/v1/crm/followups?waNumber=${WA_A}&contactNumber=${CONTACT}`);
  assert.equal(bList.body.total, 0);
  const done = await ownerA.fetch(`/api/v1/crm/followups/${created.body.id}/complete`, { method: 'POST' });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'done');
  const again = await ownerA.fetch(`/api/v1/crm/followups/${created.body.id}/complete`, { method: 'POST' });
  assert.equal(again.status, 404, 'double-complete rejected');
  const c2 = await ownerA.fetch('/api/v1/crm/followups', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT, dueAt: '3d' }),
  });
  const cancel = await ownerA.fetch(`/api/v1/crm/followups/${c2.body.id}/cancel`, { method: 'POST' });
  assert.equal(cancel.body.status, 'cancelled');
});

// --- Timeline ------------------------------------------------------------------------------------

wire('timeline merges all sources, org-scoped, CoT-free', async () => {
  await ownerA.fetch('/api/v1/crm/notes', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT, body: 'Timeline note' }),
  });
  await pool.query(
    `INSERT INTO coexistence.lead_qualifications
       (organization_id, wa_number, contact_number, inbound_message_id, status, score, summary)
     VALUES ($1, $2, $3, $4, 'qualified', 90, 'Strong fit')`,
    [orgA, WA_A, CONTACT, `${TAG}-m-tl`]
  );
  await pool.query(
    `INSERT INTO coexistence.chat_history
       (message_id, wa_number, contact_number, direction, message_type, message_body, status, timestamp, organization_id)
     VALUES ($1, $2, $3, 'incoming', 'text', 'hello timeline', 'received', NOW(), $4)`,
    [`${TAG}-m-tl`, WA_A, CONTACT, orgA]
  );
  const tl = await ownerA.fetch(`/api/v1/crm/activity?waNumber=${WA_A}&contactNumber=${CONTACT}`);
  assert.equal(tl.status, 200);
  const kinds = tl.body.map((t) => t.kind);
  for (const k of ['note added', 'AI qualification', 'WhatsApp inbound']) {
    assert.ok(kinds.includes(k), `timeline has ${k}: ${kinds}`);
  }
  for (const t of tl.body) {
    assert.ok(!('reasoning' in t) && !('chainOfThought' in t), 'no internals');
  }
  assert.ok(tl.body.length <= 50, 'bounded');
  const bTl = await ownerB.fetch(`/api/v1/crm/activity?waNumber=${WA_A}&contactNumber=${CONTACT}`);
  assert.equal(bTl.status, 404, 'B timeline blocked');
});

// --- List: pagination / filters ----------------------------------------------------------------------

wire('lead list paginates and filters within the tenant', async () => {
  for (let i = 0; i < 15; i++) {
    const num = `1999888${String(4000 + i)}`;
    await ownerA.fetch('/api/v1/leads', {
      method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: num, name: `Bulk ${i}` }),
    });
  }
  const p1 = await ownerA.fetch('/api/v1/leads?limit=10&page=1');
  assert.equal(p1.status, 200);
  assert.equal(p1.body.data.length, 10, 'page bounded');
  assert.ok(p1.body.total >= 15);
  assert.ok(p1.body.totalPages >= 2);
  const p2 = await ownerA.fetch('/api/v1/leads?limit=10&page=2');
  const ids1 = new Set(p1.body.data.map((l) => l.id));
  assert.ok(p2.body.data.every((l) => !ids1.has(l.id)), 'pages do not overlap');
  const big = await ownerA.fetch('/api/v1/leads?limit=5000');
  assert.ok(big.body.data.length <= 100, 'limit clamped');
  const search = await ownerA.fetch('/api/v1/leads?search=Bulk%201');
  assert.ok(search.body.data.length >= 1 && search.body.data.every((l) => (l.name || '').includes('Bulk 1')));
  const assigned = await ownerA.fetch(`/api/v1/leads?assignedUserId=${memberAId}`);
  assert.ok(assigned.body.data.every((l) => String(l.assignedUserId) === String(memberAId)), 'assignee filter holds');
  const bList = await ownerB.fetch('/api/v1/leads?limit=100');
  const aIds = new Set([...p1.body.data, ...p2.body.data].map((l) => String(l.id)));
  assert.ok(bList.body.data.every((l) => !aIds.has(String(l.id))), 'filters cannot escape tenant');
});

// --- Concurrency -------------------------------------------------------------------------------------------

wire('concurrent stage moves converge to one consistent state', async () => {
  const s1 = stagesA[0].id;
  const s2 = stagesA[1].id;
  const results = await Promise.allSettled([
    ownerA.fetch(`/api/v1/leads/${leadId}/stage`, { method: 'PATCH', body: JSON.stringify({ stageId: s1 }) }),
    ownerA.fetch(`/api/v1/leads/${leadId}/stage`, { method: 'PATCH', body: JSON.stringify({ stageId: s2 }) }),
  ]);
  assert.ok(results.every((r) => r.status === 'fulfilled' && r.value.status === 200), 'both moves accepted');
  const { rows } = await pool.query(
    `SELECT pipeline_stage_id FROM coexistence.contacts WHERE id = $1`, [leadId]
  );
  assert.ok([String(s1), String(s2)].includes(String(rows[0].pipeline_stage_id)), 'single consistent stage');
});

// --- Loop safety -----------------------------------------------------------------------------------------------

wire('CRM status automation terminates via visited/depth guards', async () => {
  // Looping automation: any lead.status.changed → set qualification back.
  // Seeds a qualification so the update action has something to change.
  await pool.query(
    `INSERT INTO coexistence.lead_qualifications
       (organization_id, wa_number, contact_number, inbound_message_id, status, summary)
     VALUES ($1, $2, $3, $4, 'needs-more-information', 'seed')
     ON CONFLICT (organization_id, inbound_message_id) DO NOTHING`,
    [orgA, WA_A, CONTACT, `${TAG}-m-loop`]
  );
  const mk = await ownerA.fetch('/api/v1/automations', {
    method: 'POST',
    body: JSON.stringify({
      name: `${TAG} loop`, status: 'active',
      config: {
        nodes: [
          { id: 't', type: 'trigger', triggerKind: 'lead_status_changed' },
          { id: 'a', type: 'action', actions: [{ kind: 'Update Lead Status', value: 'contacted' }] },
        ],
        edges: [{ from: 't', to: 'a' }],
      },
    }),
  });
  assert.equal(mk.status, 201);
  const loopId = mk.body.id;
  const r = await ownerA.fetch(`/api/v1/leads/${leadId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'qualified' }) });
  assert.equal(r.status, 200);
  const { rows: first } = await pool.query(
    `SELECT id, depth FROM coexistence.automation_executions
      WHERE organization_id = $1 AND automation_id = $2 AND trigger_type = 'lead.status.changed'
      ORDER BY created_at DESC LIMIT 1`,
    [orgA, loopId]
  );
  assert.equal(first.length, 1, 'status change fired the automation once');
  const { processJob } = require('../src/queue/automationQueue');
  const w = await processJob({ data: {
    organizationId: orgA, automationId: loopId, executionId: first[0].id, eventId: 'evt-loop-test',
  } });
  assert.equal(w.status, 'success');
  // The update action re-emitted with depth+1 and visited=[loop]; the loop
  // automation is therefore skipped on the chained event — exactly one
  // chained execution exists and nothing deeper.
  const { rows: chained } = await pool.query(
    `SELECT depth FROM coexistence.automation_executions
      WHERE organization_id = $1 AND automation_id = $2 AND trigger_type = 'lead.status.changed'
        AND created_at > NOW() - INTERVAL '5 minutes'`,
    [orgA, loopId]
  );
  assert.ok(chained.length <= 2, `bounded chain, got ${chained.length}`);
  assert.ok(!chained.some((c) => c.depth > 1), 'no depth beyond 1');
});

// --- E2E sales flow -----------------------------------------------------------------------------------------------

wire('e2e sales flow: inbound → lead → qualify → stage → automation → timeline + socket', async () => {
  const c3 = '19998884444';
  const m = `${TAG}-m-e2e`;
  await pool.query(
    `INSERT INTO coexistence.chat_history
       (message_id, wa_number, contact_number, direction, message_type, message_body, status, timestamp, organization_id)
     VALUES ($1, $2, $3, 'incoming', 'text', 'Hi, I need pricing', 'received', NOW(), $4)`,
    [m, WA_A, c3, orgA]
  );
  await pool.query(
    `INSERT INTO coexistence.contacts (wa_number, contact_number, organization_id) VALUES ($1, $2, $3)
     ON CONFLICT (wa_number, contact_number) DO NOTHING`,
    [WA_A, c3, orgA]
  );
  // AI qualification result lands (as Phase 9 would write it).
  await pool.query(
    `INSERT INTO coexistence.lead_qualifications
       (organization_id, wa_number, contact_number, inbound_message_id, status, score, summary)
     VALUES ($1, $2, $3, $4, 'qualified', 88, 'Asked for pricing, budget confirmed')`,
    [orgA, WA_A, c3, m]
  );
  const a1 = sockClient(ownerAId);
  const b1 = sockClient(ownerBId);
  await Promise.all([waitFor(a1, 'connect'), waitFor(b1, 'connect')]);
  const aEvents = [];
  let bGot = false;
  for (const ev of ['lead-status-changed', 'lead-assigned', 'lead-updated']) {
    a1.on(ev, () => aEvents.push(ev));
    b1.on(ev, () => { bGot = true; });
  }
  // Stage + assign through the canonical API.
  const st = await ownerA.fetch(`/api/v1/leads/by-contact?waNumber=${WA_A}&contactNumber=${c3}`);
  assert.equal(st.status, 200);
  assert.equal(st.body.qualification.status, 'qualified', 'AI state visible in CRM');
  assert.equal(st.body.qualification.score, 88);
  const asg = await ownerA.fetch(`/api/v1/leads/${st.body.id}/assign`, { method: 'PATCH', body: JSON.stringify({ userId: memberAId }) });
  assert.equal(asg.status, 200);
  const stg = await ownerA.fetch(`/api/v1/leads/${st.body.id}/stage`, { method: 'PATCH', body: JSON.stringify({ stageId: stagesA[1].id }) });
  assert.equal(stg.status, 200);
  const note = await ownerA.fetch('/api/v1/crm/notes', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: c3, body: 'Sent pricing deck' }),
  });
  assert.equal(note.status, 201);
  const fu = await ownerA.fetch('/api/v1/crm/followups', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: c3, dueAt: '2d' }),
  });
  assert.equal(fu.status, 201);
  const tl = await ownerA.fetch(`/api/v1/crm/activity?waNumber=${WA_A}&contactNumber=${c3}`);
  const kinds = tl.body.map((t) => t.kind);
  for (const k of ['AI qualification', 'WhatsApp inbound', 'note added', 'follow-up created']) {
    assert.ok(kinds.includes(k), `timeline has ${k}`);
  }
  await sleep(300);
  assert.ok(aEvents.includes('lead-assigned'), 'A got assigned');
  assert.ok(aEvents.includes('lead-updated'), 'A got stage update');
  assert.equal(bGot, false, 'B got NOTHING');
  a1.close();
  b1.close();
});

// --- contacts/save hardening -------------------------------------------------------------------------------------

wire('contacts/save enforces org boundary + member assignment', async () => {
  // ownerB is a global admin but a stranger to orgA: forged save must 403.
  const forged = await ownerB.fetch('/api/contacts/save', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT, name: 'Mallory' }),
  });
  assert.equal(forged.status, 403, 'cross-org save rejected');
  const { rows: nm } = await pool.query(
    `SELECT name FROM coexistence.contacts WHERE organization_id = $1 AND contact_number = $2`, [orgA, CONTACT]
  );
  assert.ok((nm[0]?.name || '') !== 'Mallory');
  // Admin assigning a foreign user fails.
  const badAssign = await ownerA.fetch('/api/contacts/save', {
    method: 'POST',
    body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT, assignedUserId: ownerBId }),
  });
  assert.equal(badAssign.status, 400, 'foreign assignee rejected');
  // Legacy behavior intact: own-org save works.
  const ok = await ownerA.fetch('/api/contacts/save', {
    method: 'POST', body: JSON.stringify({ waNumber: WA_A, contactNumber: CONTACT, name: `${TAG} Asha` }),
  });
  assert.equal(ok.status, 200);
});
