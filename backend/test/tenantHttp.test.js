// Green Pilot HTTP-level tenant isolation (Step 12, wire path).
//
// Boots the real Express app on an ephemeral port (no workers) against the
// migration-provisioned database and verifies cross-tenant access fails over
// the wire: forged X-Org-Id, foreign org member lists, foreign WA accounts,
// unauthenticated access. Skips cleanly without a database.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();

let pool = null;
let dbAvailable = false;
let server = null;
let base = '';
const TAG = `http-${Date.now()}`;

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

const A = jar();
const B = jar();
const anon = jar();
let orgA = null;
let orgB = null;
let userAId = null;
let userBId = null;
let accountAId = null;

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
  // Fresh users (setup may already be consumed on this DB).
  async function mkUser(name) {
    const email = `${TAG}-${name}@http.test`;
    await pool.query(
      `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role)
       VALUES ($1, $2, 'x', $3, 'admin')
       ON CONFLICT (email) DO NOTHING`,
      [`${TAG}-${name}`, email, name]
    );
    const { rows } = await pool.query(
      `SELECT id FROM coexistence.forgecrm_users WHERE email = $1`, [email]
    );
    return { id: rows[0].id, email };
  }
  const ua = await mkUser('alpha');
  const ub = await mkUser('beta');
  userAId = ua.id;
  userBId = ub.id;

  const { app } = require('../src/index');
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // Log in over the wire (dev users use password 'x' hash placeholder — set a
  // real one first via bcrypt-free direct update is overkill; instead use the
  // API: try setup, else fall back to password login after setting passwords).
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(`${TAG}-pw`, 4);
  await pool.query(`UPDATE coexistence.forgecrm_users SET password = $1 WHERE id IN ($2, $3)`, [hash, userAId, userBId]);

  let r = await A.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: ua.email, password: `${TAG}-pw` }) });
  assert.equal(r.status, 200, 'A login works');
  r = await B.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: ub.email, password: `${TAG}-pw` }) });
  assert.equal(r.status, 200, 'B login works');

  r = await A.fetch('/api/v1/orgs', { method: 'POST', body: JSON.stringify({ name: `${TAG} alpha` }) });
  assert.equal(r.status, 201, 'A creates org');
  orgA = r.body.id;
  r = await B.fetch('/api/v1/orgs', { method: 'POST', body: JSON.stringify({ name: `${TAG} beta` }) });
  assert.equal(r.status, 201, 'B creates org');
  orgB = r.body.id;

  // A-owned WhatsApp account (direct insert — creation endpoint needs Meta).
  const acc = await pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (display_name, display_phone_number, phone_number_id, waba_id,
        access_token_encrypted, verify_token_encrypted, is_default, is_active, organization_id)
     VALUES ('http alpha', '15550003333', $1, $2, 'enc', 'enc', TRUE, TRUE, $3) RETURNING id`,
    [`${TAG}-pn-http`, `${TAG}-waba-http`, orgA]
  );
  accountAId = acc.rows[0].id;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  // Requiring the app pulls in BullMQ queue modules (background Redis handles
  // that would otherwise keep the test process alive) — drain them.
  try {
    const { shutdownSendQueue } = require('../src/queue/sendQueue');
    const { shutdownAgentQueue } = require('../src/queue/agentQueue');
    const { shutdown: shutdownMediaQueue } = require('../src/queue/mediaQueue');
    const { shutdownAutomationQueue } = require('../src/queue/automationQueue');
    await shutdownSendQueue().catch(() => {});
    await shutdownAgentQueue().catch(() => {});
    await shutdownMediaQueue().catch(() => {});
    await shutdownAutomationQueue().catch(() => {});
  } catch { /* already torn down */ }
  if (!dbAvailable) return;
  await pool.query(`DELETE FROM coexistence.whatsapp_accounts WHERE phone_number_id LIKE '${TAG}-%'`);
  await pool.query(`DELETE FROM coexistence.organization_members WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE slug LIKE '${TAG}%' OR name LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.organizations WHERE slug LIKE '${TAG}%' OR name LIKE '${TAG}%'`);
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

wire('unauthenticated API access is 401', async () => {
  const r = await anon.fetch('/api/auth/me');
  assert.equal(r.status, 401);
});

wire('A cannot list B org members (403) and vice versa', async () => {
  const r1 = await A.fetch(`/api/v1/orgs/${orgB}/members`);
  assert.equal(r1.status, 403);
  const r2 = await B.fetch(`/api/v1/orgs/${orgA}/members`);
  assert.equal(r2.status, 403);
  const own = await A.fetch(`/api/v1/orgs/${orgA}/members`);
  assert.equal(own.status, 200);
});

wire('forged X-Org-Id fails closed (403, not 500)', async () => {
  // A is not a member of B: the tenant layer rejects before any handler runs.
  const forged = await A.fetch(`/api/whatsapp-accounts/${accountAId}`, { headers: { 'X-Org-Id': orgB } });
  assert.equal(forged.status, 403);
  // Sanity: unguarded own-context calls still work.
  const own = await A.fetch('/api/v1/orgs');
  assert.equal(own.status, 200);
  assert.ok(own.body.some((o) => String(o.id) === String(orgA)));
});

wire('member of two orgs cannot cross-read accounts between them (404, no leak)', async () => {
  // A creates a second org: A is now a legitimate member of both, so the
  // request reaches the handler — which must 404 (not 403/200) on the
  // foreign-org account id, proving ids are unguessable across tenants.
  const r = await A.fetch('/api/v1/orgs', { method: 'POST', body: JSON.stringify({ name: `${TAG} alpha-2` }) });
  assert.equal(r.status, 201);
  const orgA2 = r.body.id;
  const cross = await A.fetch(`/api/whatsapp-accounts/${accountAId}`, { headers: { 'X-Org-Id': orgA2 } });
  assert.equal(cross.status, 404);
  const own = await A.fetch(`/api/whatsapp-accounts/${accountAId}`, { headers: { 'X-Org-Id': orgA } });
  assert.equal(own.status, 200);
});

wire('B cannot read A WhatsApp account over HTTP (404, no leak)', async () => {
  const r = await B.fetch(`/api/whatsapp-accounts/${accountAId}`);
  assert.equal(r.status, 404);
  const own = await A.fetch(`/api/whatsapp-accounts/${accountAId}`);
  assert.equal(own.status, 200);
});

wire('B cannot remove A from A org (403)', async () => {
  const r = await B.fetch(`/api/v1/orgs/${orgA}/members/${userAId}`, { method: 'DELETE' });
  assert.equal(r.status, 403);
  const members = await A.fetch(`/api/v1/orgs/${orgA}/members`);
  assert.ok(members.body.some((m) => String(m.user_id) === String(userAId)));
});

wire('v1 org webhook rejects unknown org without leaking (404)', async () => {
  // Phase 13: webhooks fail closed without META_APP_SECRET, so opt into
  // unverified processing explicitly to exercise the org-routing contract.
  process.env.ALLOW_UNVERIFIED_WEBHOOKS = 'true';
  try {
    const r = await anon.fetch('/api/v1/webhooks/whatsapp/00000000-0000-4000-8000-000000000000', {
      method: 'POST',
      body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
    });
    assert.equal(r.status, 404);
  } finally {
    delete process.env.ALLOW_UNVERIFIED_WEBHOOKS;
  }
});
