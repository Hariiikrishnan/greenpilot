// Phase 13 production-hardening regression tests (wire path).
//
// Boots the real Express app on an ephemeral port against the
// migration-provisioned database and proves the forensic fixes over the wire:
// dashboard + numbers org scoping, webhook fail-closed + unknown-number skip +
// contact upsert isolation, readiness/liveness, request ids, cookie clearing,
// and auth rate limiting. Skips cleanly without a database.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();

let pool = null;
let dbAvailable = false;
let server = null;
let base = '';
const TAG = `ph13-${Date.now().toString(36)}`;
const WA_A = '15550001111';
const WA_B = '15550002222';

function jar() {
  const cookies = [];
  return {
    cookies,
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
      const headers = {};
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of set) cookies.push(c.split(';')[0]);
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body, headers, setCookie: set };
    },
  };
}

const a = jar();
const b = jar();
const anon = jar();
let orgA = null;
let orgB = null;

function metaText(pnId, wa, contact, wamid, name, textBody) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: pnId, display_phone_number: wa },
          contacts: [{ wa_id: contact, profile: { name } }],
          messages: [{
            id: wamid, from: contact,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text', text: { body: textBody },
          }],
        },
      }],
    }],
  };
}

async function mkAdmin(name) {
  const email = `${TAG}-${name}@ph13.test`;
  await pool.query(
    `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role)
     VALUES ($1, $2, 'x', $3, 'admin')
     ON CONFLICT (email) DO NOTHING`,
    [`${TAG}-${name}`, email, name]
  );
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(`${TAG}-pw`, 4);
  await pool.query(`UPDATE coexistence.forgecrm_users SET password = $1 WHERE email = $2`, [hash, email]);
  return email;
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
  const { app } = require('../src/index');
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const emailA = await mkAdmin('admina');
  const emailB = await mkAdmin('adminb');
  let r = await a.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: emailA, password: `${TAG}-pw` }) });
  assert.equal(r.status, 200, 'A login works');
  r = await b.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: emailB, password: `${TAG}-pw` }) });
  assert.equal(r.status, 200, 'B login works');

  r = await a.fetch('/api/v1/orgs', { method: 'POST', body: JSON.stringify({ name: `${TAG} org-a` }) });
  assert.equal(r.status, 201, 'A creates org');
  orgA = r.body.id;
  r = await b.fetch('/api/v1/orgs', { method: 'POST', body: JSON.stringify({ name: `${TAG} org-b` }) });
  assert.equal(r.status, 201, 'B creates org');
  orgB = r.body.id;

  // WhatsApp accounts (direct insert — creation endpoint needs Meta).
  await pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (display_name, display_phone_number, phone_number_id, waba_id,
        access_token_encrypted, verify_token_encrypted, is_default, is_active, organization_id)
     VALUES
       ('ph13 A', $1, $2, $3, 'enc', 'enc', TRUE, TRUE, $4),
       ('ph13 B', $5, $6, $7, 'enc', 'enc', TRUE, TRUE, $8)`,
    [WA_A, `${TAG}-pn-a`, `${TAG}-waba-a`, orgA, WA_B, `${TAG}-pn-b`, `${TAG}-waba-b`, orgB]
  );

  // Same wa_number shared across orgs: the tenant boundary must decide.
  await pool.query('DELETE FROM coexistence.contacts WHERE wa_number IN ($1, $2)', [WA_A, WA_B]);
  await pool.query(
    `INSERT INTO coexistence.contacts (wa_number, contact_number, name, organization_id)
     VALUES ($1, '1001', 'Alice-A', $2), ($1, '1002', 'Bob-B', $3), ($4, '2001', 'Cara-B', $3)`,
    [WA_A, orgA, orgB, WA_B]
  );
  await pool.query(
    `INSERT INTO coexistence.chat_history
       (message_id, phone_number_id, wa_number, contact_number, direction, message_type, message_body, status, timestamp, organization_id)
     VALUES
       ($1, $2, $3, '1001', 'incoming', 'text', 'hi a', 'received', NOW(), $4),
       ($5, $2, $3, '1002', 'incoming', 'text', 'hi b', 'received', NOW(), $6),
       ($7, $8, $9, '2001', 'incoming', 'text', 'hi c', 'received', NOW(), $6)`,
    [`${TAG}-mid-a1`, `${TAG}-pn-a`, WA_A, orgA, `${TAG}-mid-b1`, orgB, `${TAG}-mid-b2`, `${TAG}-pn-b`, WA_B]
  );
  await pool.query(
    `INSERT INTO coexistence.chatbots (name, status, trigger_type, config, organization_id)
     VALUES ('Auto-A', 'active', 'keyword', '{}', $1), ('Auto-B', 'active', 'keyword', '{}', $2)`,
    [orgA, orgB]
  );
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
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
  delete process.env.ALLOW_UNVERIFIED_WEBHOOKS;
  if (!dbAvailable) return;
  await pool.query(`DELETE FROM coexistence.chat_history WHERE message_id LIKE '${TAG}-%'`).catch(() => {});
  await pool.query(`DELETE FROM coexistence.contacts WHERE wa_number IN ('${WA_A}','${WA_B}') AND (name LIKE '%-A' OR name LIKE '%-B' OR profile_name LIKE '${TAG}%')`).catch(() => {});
  await pool.query(`DELETE FROM coexistence.chatbots WHERE name IN ('Auto-A','Auto-B')`).catch(() => {});
  await pool.query(`DELETE FROM coexistence.whatsapp_accounts WHERE phone_number_id LIKE '${TAG}-%'`).catch(() => {});
  await pool.query(`DELETE FROM coexistence.organization_members WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`).catch(() => {});
  await pool.query(`DELETE FROM coexistence.organizations WHERE name LIKE '${TAG}%'`).catch(() => {});
  await pool.query(`DELETE FROM coexistence.forgecrm_users WHERE username LIKE '${TAG}-%'`).catch(() => {});
});

function wire(name, fn) {
  test(name, async (t) => {
    if (!dbAvailable) {
      t.skip('no database reachable');
      return;
    }
    await fn(t);
  });
}

wire('dashboard aggregates are org-scoped (no cross-tenant counts)', async () => {
  const r = await a.fetch(`/api/dashboard?range=7d`, { headers: { 'X-Org-Id': orgA } });
  assert.equal(r.status, 200);
  const byKey = Object.fromEntries(r.body.kpis.map(k => [k.key, k]));
  assert.equal(byKey.contacts.value, 1, 'only org A contact counted');
  assert.equal(byKey.automations.value, 1, 'only org A automation counted');

  const d = await a.fetch(`/api/dashboard/details?metric=contacts&range=7d`, { headers: { 'X-Org-Id': orgA } });
  assert.equal(d.status, 200);
  assert.equal(d.body.count, 1);
  assert.equal(d.body.items[0].primary, 'Alice-A');

  const au = await a.fetch(`/api/dashboard/details?metric=automations&range=7d`, { headers: { 'X-Org-Id': orgA } });
  assert.equal(au.status, 200);
  assert.equal(au.body.count, 1);
  assert.equal(au.body.items[0].primary, 'Auto-A');

  // Org B's connected number is its own default (WA_B): only its WA_B contact
  // counts (single-connected-number semantic, unchanged). The cross-tenant
  // proof is above: org A excludes org B's row on the SAME number.
  const rb = await b.fetch(`/api/dashboard?range=7d`, { headers: { 'X-Org-Id': orgB } });
  const bKeys = Object.fromEntries(rb.body.kpis.map(k => [k.key, k]));
  assert.equal(bKeys.contacts.value, 1);
  const db = await b.fetch(`/api/dashboard/details?metric=contacts&range=7d`, { headers: { 'X-Org-Id': orgB } });
  assert.equal(db.body.count, 1);
  assert.equal(db.body.items[0].primary, 'Cara-B');
});

wire('GET /numbers is org-scoped', async () => {
  const ra = await a.fetch('/api/numbers', { headers: { 'X-Org-Id': orgA } });
  assert.equal(ra.status, 200);
  assert.equal(ra.body.length, 1);
  assert.equal(ra.body[0].wa_number, WA_A);
  assert.equal(Number(ra.body[0].message_count), 1, 'org B message on same number excluded');

  const rb = await b.fetch('/api/numbers', { headers: { 'X-Org-Id': orgB } });
  assert.equal(rb.status, 200);
  // waA is not org B's connected number (orphaned-number rule, unchanged) —
  // and org A's counts never leak in. Only org B's own connected number shows.
  assert.equal(rb.body.find(r => r.wa_number === WA_A), undefined);
  const waB = rb.body.find(r => r.wa_number === WA_B);
  assert.equal(Number(waB.message_count), 1);
});

wire('webhook fails closed without META_APP_SECRET', async (t) => {
  if (process.env.META_APP_SECRET) {
    t.skip('META_APP_SECRET is set in this env');
    return;
  }
  delete process.env.ALLOW_UNVERIFIED_WEBHOOKS;
  const r = await anon.fetch('/api/webhook/whatsapp', {
    method: 'POST',
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
  });
  assert.equal(r.status, 403);
});

wire('webhook stores known numbers with org, skips unknown numbers', async () => {
  const savedSecret = process.env.META_APP_SECRET;
  delete process.env.META_APP_SECRET;
  process.env.ALLOW_UNVERIFIED_WEBHOOKS = 'true';
  try {
    const unknown = await anon.fetch('/api/webhook/whatsapp', {
      method: 'POST',
      body: JSON.stringify(metaText(`${TAG}-pn-unknown`, '19998887777', '9001', `${TAG}-w-unknown`, 'Ghost', 'boo')),
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.stored, 0);
    const { rows: ghost } = await pool.query(
      `SELECT id FROM coexistence.chat_history WHERE message_id = $1`, [`${TAG}-w-unknown`]
    );
    assert.equal(ghost.length, 0, 'unknown number persisted nothing');

    const known = await anon.fetch('/api/webhook/whatsapp', {
      method: 'POST',
      body: JSON.stringify(metaText(`${TAG}-pn-a`, WA_A, '1001', `${TAG}-w-known`, 'Alice-Webhook', 'hello')),
    });
    assert.equal(known.status, 200);
    assert.equal(known.body.stored, 1);
    const { rows } = await pool.query(
      `SELECT organization_id FROM coexistence.chat_history WHERE message_id = $1`, [`${TAG}-w-known`]
    );
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].organization_id), String(orgA));
  } finally {
    delete process.env.ALLOW_UNVERIFIED_WEBHOOKS;
    if (savedSecret) process.env.META_APP_SECRET = savedSecret;
  }
});

wire('webhook contact upsert never clobbers another org', async () => {
  const savedSecret = process.env.META_APP_SECRET;
  delete process.env.META_APP_SECRET;
  process.env.ALLOW_UNVERIFIED_WEBHOOKS = 'true';
  try {
    // Org B account reusing the SAME wa_number (shared-pair collision).
    await pool.query(
      `INSERT INTO coexistence.whatsapp_accounts
         (display_name, display_phone_number, phone_number_id, waba_id,
          access_token_encrypted, verify_token_encrypted, is_default, is_active, organization_id)
       VALUES ('ph13 B2', $1, $2, $3, 'enc', 'enc', FALSE, TRUE, $4)`,
      [WA_A, `${TAG}-pn-b2`, `${TAG}-waba-b2`, orgB]
    );
    const r = await anon.fetch(`/api/v1/webhooks/whatsapp/${orgB}`, {
      method: 'POST',
      body: JSON.stringify(metaText(`${TAG}-pn-b2`, WA_A, '1001', `${TAG}-w-evil`, 'Evil-B', 'hijack')),
    });
    assert.equal(r.status, 200);
    const { rows } = await pool.query(
      `SELECT name, profile_name, organization_id FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = '1001'`,
      [WA_A]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Alice-A', 'org A name untouched');
    assert.equal(String(rows[0].organization_id), String(orgA), 'row still belongs to org A');
  } finally {
    delete process.env.ALLOW_UNVERIFIED_WEBHOOKS;
    if (savedSecret) process.env.META_APP_SECRET = savedSecret;
  }
});

wire('liveness/readiness/request-id/logout-cookie contract', async () => {
  const h = await anon.fetch('/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);

  const r = await anon.fetch('/ready');
  assert.ok([200, 503].includes(r.status));
  assert.equal(typeof r.body.checks.db, 'boolean');
  assert.equal(typeof r.body.checks.migrations, 'boolean');
  assert.equal(typeof r.body.checks.redis, 'boolean');
  assert.equal(r.body.checks.db, true);
  assert.equal(r.body.checks.migrations, true);
  assert.ok(!JSON.stringify(r.body).includes('postgres'), 'no infra details leak');

  const withId = await anon.fetch('/health', { headers: { 'X-Request-Id': 'smoke-123' } });
  assert.equal(withId.headers['x-request-id'], 'smoke-123');

  const out = await a.fetch('/api/auth/logout', { method: 'POST' });
  assert.equal(out.status, 200);
  const cookie = out.setCookie.join(';');
  assert.ok(/Path=\//i.test(cookie), 'logout clears with Path=/');
  assert.ok(/SameSite=Strict/i.test(cookie), 'logout clears with SameSite');
  // Re-login A for the remaining tests.
  const emailA = `${TAG}-admina@ph13.test`;
  const back = await a.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: emailA, password: `${TAG}-pw` }) });
  assert.equal(back.status, 200);
});

wire('auth endpoints are brute-force limited (LAST — exhausts the IP bucket)', async () => {
  let last = null;
  for (let i = 0; i < 35; i++) {
    last = await anon.fetch('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ email: `${TAG}-nobody@ph13.test`, password: 'wrong-password' }),
    });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429, 'stuffing is throttled');
  assert.ok(/later|many/i.test(last.body.error));
});
