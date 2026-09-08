// Green Pilot Phase 8 billing tests.
//
// Pure unit parts (plan catalog, state machine, HMAC verification) ALWAYS run.
// DB-backed parts (isolation, role auth, orders, verification, idempotency,
// webhooks, quotas, concurrency, expiry) self-provision the schema and skip
// cleanly without a database — same pattern as tenantIsolation.test.js.
//
// NOTE: sets RAZORPAY_* test credentials + stubs global fetch (provider order
// API) for the DB section only; both are restored in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

require('dotenv').config();

const { getPlan, publicPlans } = require('../src/billing/plans');
const { subscriptionState } = require('../src/billing/subscriptions');
const razorpay = require('../src/billing/razorpay');

// --- Pure unit tests (no DB) -------------------------------------------------

test('plan catalog is server-side: known plans resolve, unknown is null', () => {
  assert.equal(getPlan('trial').id, 'trial');
  assert.equal(getPlan('STARTER').id, 'starter');
  assert.equal(getPlan('nope'), null);
  assert.equal(getPlan(''), null);
});

test('public plan projection carries no secrets and flags placeholders', () => {
  const plans = publicPlans();
  assert.ok(plans.length >= 4);
  const flat = JSON.stringify(plans);
  assert.ok(!/secret|token|password|key_id/i.test(flat), `catalog leaked: ${flat}`);
  for (const p of plans) assert.equal(p.pricingFinalized, false);
});

test('subscriptionState matrix', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const cases = [
    [{ status: 'trialing', plan: 'trial', trial_ends_at: '2026-06-10T00:00:00Z' }, 'trialing', true],
    [{ status: 'trial', plan: 'trial', trial_ends_at: '2026-05-01T00:00:00Z' }, 'expired', false],
    [{ status: 'active', plan: 'starter', current_period_end: '2026-07-01T00:00:00Z' }, 'active', true],
    [{ status: 'active', plan: 'starter', current_period_end: '2026-05-01T00:00:00Z' }, 'expired', false],
    [{ status: 'past_due', plan: 'starter' }, 'past_due', false],
    [{ status: 'cancelled', plan: 'growth' }, 'cancelled', false],
    [{ status: 'expired', plan: 'trial' }, 'expired', false],
    [{ status: 'suspended', plan: 'scale' }, 'suspended', false],
    [{ status: 'weird', plan: 'weird' }, 'expired', false], // unknown → fail closed
    [{ status: 'active', plan: 'trial' }, 'trialing', true], // legacy default row
  ];
  for (const [row, state, entitled] of cases) {
    const r = subscriptionState(row, now);
    assert.equal(r.state, state, JSON.stringify(row));
    assert.equal(r.entitled, entitled, JSON.stringify(row));
  }
});

test('payment HMAC verification accepts the true signature only', () => {
  const prev = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_SECRET = 'unit-secret';
  try {
    const orderId = 'order_unit1';
    const paymentId = 'pay_unit1';
    const good = crypto.createHmac('sha256', 'unit-secret').update(`${orderId}|${paymentId}`).digest('hex');
    assert.equal(razorpay.verifyPaymentSignature({ orderId, paymentId, signature: good }), true);
    assert.equal(razorpay.verifyPaymentSignature({ orderId, paymentId, signature: '0'.repeat(64) }), false);
    assert.equal(razorpay.verifyPaymentSignature({ orderId, paymentId, signature: '' }), false);
    assert.equal(razorpay.verifyPaymentSignature({ orderId, paymentId: 'other', signature: good }), false);
  } finally {
    if (prev === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prev;
  }
});

test('webhook HMAC verification accepts the true raw-body signature only', () => {
  const prev = process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = 'unit-wh-secret';
  try {
    const raw = Buffer.from('{"event":"order.paid"}', 'utf8');
    const good = crypto.createHmac('sha256', 'unit-wh-secret').update(raw).digest('hex');
    assert.equal(razorpay.verifyWebhookSignature(raw, good), true);
    assert.equal(razorpay.verifyWebhookSignature(raw, 'deadbeef'), false);
    assert.equal(razorpay.verifyWebhookSignature(null, good), false);
  } finally {
    if (prev === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = prev;
  }
});

// --- DB-backed tests ----------------------------------------------------------

let pool = null;
let dbAvailable = false;
let server = null;
let base = '';
const TAG = `bill-${Date.now()}`;

const TEST_KEY_ID = 'rzp_test_phase8';
const TEST_SECRET = 'test_secret_phase8';
const TEST_WH_SECRET = 'test_wh_secret_phase8';
let orderCounter = 0;
const realFetch = globalThis.fetch;

function signPayment(orderId, paymentId) {
  return crypto.createHmac('sha256', TEST_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

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
const memberA = jar();
const ownerB = jar();
const anon = jar();
let orgA = null;
let orgB = null;

before(async () => {
  process.env.RAZORPAY_KEY_ID = TEST_KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = TEST_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WH_SECRET;
  // Provider order API stub — no network in tests.
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('api.razorpay.com')) {
      const body = JSON.parse(opts.body);
      orderCounter += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: `order_test_${TAG}_${orderCounter}`,
          amount: body.amount,
          currency: body.currency,
        }),
      };
    }
    return realFetch(url, opts);
  };
  try {
    pool = require('../src/db');
    await pool.query('SELECT 1');
    const { runMigrations } = require('../src/db/migrate');
    await runMigrations(pool);
    dbAvailable = true;
  } catch {
    return;
  }
  async function mkUser(name, role = 'admin') {
    // Login lowercases emails (correct case-insensitive behavior), so the
    // fixture must store lowercase emails/usernames (display name keeps case).
    const email = `${TAG}-${name}@bill.test`.toLowerCase();
    await pool.query(
      `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role)
       VALUES ($1, $2, 'x', $3, $4) ON CONFLICT (email) DO NOTHING`,
      [`${TAG}-${name}`.toLowerCase(), email, name, role]
    );
    const { rows } = await pool.query(
      `SELECT id FROM coexistence.forgecrm_users WHERE email = $1`, [email]
    );
    return { id: rows[0].id, email };
  }
  const ua = await mkUser('ownerA');
  const um = await mkUser('memberA', 'bda_sales');
  const ub = await mkUser('ownerB');

  const { app } = require('../src/index');
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  base = `http://127.0.0.1:${(addr && typeof addr === 'object' ? addr.port : 0)}`;

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(`${TAG}-pw`, 4);
  await pool.query(`UPDATE coexistence.forgecrm_users SET password = $1 WHERE email LIKE '${TAG}-%'`, [hash]);

  let r = await ownerA.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: ua.email, password: `${TAG}-pw` }) });
  assert.equal(r.status, 200, 'ownerA login works');
  r = await memberA.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: um.email, password: `${TAG}-pw` }) });
  assert.equal(r.status, 200, 'memberA login works');
  r = await ownerB.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: ub.email, password: `${TAG}-pw` }) });
  assert.equal(r.status, 200, 'ownerB login works');

  r = await ownerA.fetch('/api/v1/orgs', { method: 'POST', body: JSON.stringify({ name: `${TAG} alpha` }) });
  assert.equal(r.status, 201, 'ownerA creates orgA');
  orgA = r.body.id;
  r = await ownerB.fetch('/api/v1/orgs', { method: 'POST', body: JSON.stringify({ name: `${TAG} beta` }) });
  assert.equal(r.status, 201, 'ownerB creates orgB');
  orgB = r.body.id;

  // memberA joins orgA as plain member (global role bda_sales is irrelevant).
  r = await ownerA.fetch(`/api/v1/orgs/${orgA}/members`, {
    method: 'POST', body: JSON.stringify({ email: um.email, role: 'member' }),
  });
  assert.equal(r.status, 201, 'memberA added to orgA');
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
  globalThis.fetch = realFetch;
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!dbAvailable) return;
  await pool.query(`DELETE FROM coexistence.billing_orders WHERE receipt LIKE 'gp_%' OR receipt LIKE '${TAG}%'`);
  await pool.query(`DELETE FROM coexistence.ai_usage_ledger WHERE inbound_message_id LIKE '${TAG}-%'`);
  await pool.query(`DELETE FROM coexistence.billing_subscriptions WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`);
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

wire('billing status: trial entitled with usage; manager flags differ by role', async () => {
  const a = await ownerA.fetch('/api/v1/billing/status');
  assert.equal(a.status, 200);
  assert.equal(a.body.plan, 'trial');
  assert.equal(a.body.state, 'trialing');
  assert.equal(a.body.entitled, true);
  assert.equal(a.body.canManageBilling, true);
  assert.ok(a.body.usage.granted >= 100, `trial grant seeded: ${JSON.stringify(a.body.usage)}`);
  assert.equal(a.body.pricingFinalized, false);
  const flat = JSON.stringify(a.body);
  assert.ok(!flat.includes(TEST_SECRET), 'status leaks provider secret');

  const m = await memberA.fetch('/api/v1/billing/status');
  assert.equal(m.status, 200);
  assert.equal(m.body.canManageBilling, false);
});

wire('plans endpoint is server-controlled (no secrets)', async () => {
  const r = await ownerA.fetch('/api/v1/billing/plans');
  assert.equal(r.status, 200);
  assert.ok(r.body.plans.length >= 4);
  const flat = JSON.stringify(r.body);
  assert.ok(!flat.includes(TEST_SECRET));
});

wire('unauthenticated billing access is 401; forged org is 403', async () => {
  const u = await anon.fetch('/api/v1/billing/status');
  assert.equal(u.status, 401);
  const forged = await ownerA.fetch('/api/v1/billing/status', { headers: { 'X-Org-Id': orgB } });
  assert.equal(forged.status, 403);
});

wire('org B cannot touch org A billing (isolation)', async () => {
  const r = await ownerB.fetch('/api/v1/billing/status', { headers: { 'X-Org-Id': orgA } });
  assert.equal(r.status, 403);
  const w = await ownerB.fetch('/api/v1/billing/create-order', {
    method: 'POST', headers: { 'X-Org-Id': orgA }, body: JSON.stringify({ plan: 'starter' }),
  });
  assert.equal(w.status, 403);
});

wire('plain member cannot manage billing (role auth)', async () => {
  const o = await memberA.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'starter' }) });
  assert.equal(o.status, 403);
  const v = await memberA.fetch('/api/v1/billing/verify-payment', {
    method: 'POST', body: JSON.stringify({ providerOrderId: 'x', providerPaymentId: 'y', signature: 'z' }),
  });
  assert.equal(v.status, 403);
  const c = await memberA.fetch('/api/v1/billing/cancel', { method: 'POST' });
  assert.equal(c.status, 403);
});

wire('order creation: valid plan → order with SAFE fields only', async () => {
  const r = await ownerA.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'starter' }) });
  assert.ok(r.status === 201 || r.status === 200, `order created: ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(r.body.providerOrderId);
  assert.ok(r.body.publicKey === TEST_KEY_ID);
  assert.equal(r.body.plan, 'starter');
  const flat = JSON.stringify(r.body);
  assert.ok(!flat.includes(TEST_SECRET), 'order response leaks secret');
});

wire('order creation rejects trial and unknown plans', async () => {
  const t = await ownerA.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'trial' }) });
  assert.equal(t.status, 400);
  const u = await ownerA.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'diamond' }) });
  assert.equal(u.status, 400);
});

wire('order creation fails closed without provider credentials (503, no fake)', async () => {
  const prev = process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_ID;
  try {
    // Use orgB (no recent open order) so the test reaches the provider gate.
    const r = await ownerB.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'growth' }) });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'billing-unavailable');
  } finally {
    if (prev !== undefined) process.env.RAZORPAY_KEY_ID = prev;
  }
});

wire('duplicate create-order reuses the open order (idempotent)', async () => {
  const r1 = await ownerA.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'starter' }) });
  const r2 = await ownerA.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'starter' }) });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.reused, true);
  assert.equal(r2.body.providerOrderId, r1.body.providerOrderId);
});

wire('payment verification: valid signature activates; replay is idempotent', async () => {
  const before = await ownerA.fetch('/api/v1/billing/status');
  const grantedBefore = before.body.usage.granted;
  const order = await ownerA.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'starter' }) });
  const oid = order.body.providerOrderId;
  const pid = `pay_${TAG}_1`;
  const payload = { providerOrderId: oid, providerPaymentId: pid, signature: signPayment(oid, pid) };

  const v1 = await ownerA.fetch('/api/v1/billing/verify-payment', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(v1.status, 200, `verify ok: ${JSON.stringify(v1.body)}`);
  assert.equal(v1.body.plan, 'starter');
  assert.equal(v1.body.state, 'active');
  assert.equal(v1.body.entitled, true);
  assert.equal(v1.body.alreadyProcessed, false);

  const v2 = await ownerA.fetch('/api/v1/billing/verify-payment', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(v2.status, 200);
  assert.equal(v2.body.alreadyProcessed, true);

  const after = await ownerA.fetch('/api/v1/billing/status');
  const plan = getPlan('starter');
  assert.equal(after.body.usage.granted, grantedBefore + plan.aiCreditsPerCycle, 'credits granted exactly once');
});

wire('payment verification: invalid signature rejected, state unchanged', async () => {
  const order = await ownerB.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'starter' }) });
  const bad = await ownerB.fetch('/api/v1/billing/verify-payment', {
    method: 'POST',
    body: JSON.stringify({ providerOrderId: order.body.providerOrderId, providerPaymentId: 'pay_x', signature: '0'.repeat(64) }),
  });
  assert.equal(bad.status, 403);
  assert.equal(bad.body.code, 'invalid-signature');
  const s = await ownerB.fetch('/api/v1/billing/status');
  assert.equal(s.body.plan, 'trial', 'failed verify changes nothing');
});

wire('payment verification: wrong-org order rejected (404, no leak)', async () => {
  const orderB = await ownerB.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'growth' }) });
  const oid = orderB.body.providerOrderId;
  const r = await ownerA.fetch('/api/v1/billing/verify-payment', {
    method: 'POST', body: JSON.stringify({ providerOrderId: oid, providerPaymentId: 'pay_z', signature: signPayment(oid, 'pay_z') }),
  });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'order-not-found');
});

wire('payment verification: tampered order amount rejected (forged price)', async () => {
  const order = await ownerB.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'growth' }) });
  const oid = order.body.providerOrderId;
  await pool.query(`UPDATE coexistence.billing_orders SET amount_paise = 999999 WHERE provider_order_id = $1`, [oid]);
  const r = await ownerB.fetch('/api/v1/billing/verify-payment', {
    method: 'POST', body: JSON.stringify({ providerOrderId: oid, providerPaymentId: 'pay_t', signature: signPayment(oid, 'pay_t') }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'order-plan-mismatch');
});

wire('webhook: valid order.paid activates; bad signature 403; unknown event ignored', async () => {
  const order = await ownerB.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'scale' }) });
  const oid = order.body.providerOrderId;
  const sendWebhook = (payloadObj) => {
    const raw = JSON.stringify(payloadObj);
    const sig = crypto.createHmac('sha256', TEST_WH_SECRET).update(raw).digest('hex');
    return globalThis.fetch(`${base}/api/v1/billing/webhook/razorpay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig },
      body: raw,
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
  };
  const good = await sendWebhook({ event: 'order.paid', payload: { order: { entity: { id: oid, payments: ['pay_wh1'] } } } });
  assert.equal(good.status, 200);
  const s = await ownerB.fetch('/api/v1/billing/status');
  assert.equal(s.body.plan, 'scale');
  assert.equal(s.body.state, 'active');

  // Replay is idempotent (still 200, single grant — covered by paid guard).
  const replay = await sendWebhook({ event: 'order.paid', payload: { order: { entity: { id: oid, payments: ['pay_wh1'] } } } });
  assert.equal(replay.status, 200);

  const raw2 = JSON.stringify({ event: 'order.paid', payload: {} });
  const forged = await globalThis.fetch(`${base}/api/v1/billing/webhook/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'bad' },
    body: raw2,
  });
  assert.equal(forged.status, 403);

  const unknown = await sendWebhook({ event: 'refund.processed', payload: {} });
  assert.equal(unknown.status, 200);
});

wire('webhook: payment.failed marks the order failed', async () => {
  const order = await ownerB.fetch('/api/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan: 'starter' }) });
  const oid = order.body.providerOrderId;
  const raw = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_fail1', order_id: oid } } } });
  const sig = crypto.createHmac('sha256', TEST_WH_SECRET).update(raw).digest('hex');
  const res = await globalThis.fetch(`${base}/api/v1/billing/webhook/razorpay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig }, body: raw,
  });
  assert.equal(res.status, 200);
  const { rows } = await pool.query(`SELECT status FROM coexistence.billing_orders WHERE provider_order_id = $1`, [oid]);
  assert.equal(rows[0].status, 'failed');
});

wire('quota: within limit allowed, over limit rejected', async () => {
  const { checkQuota, consumeQuota } = require('../src/billing/quotas');
  const ok = await checkQuota(pool, orgA, 'ai_credits', 1);
  assert.equal(ok.allowed, true);
  assert.ok(ok.remaining > 0);
  const no = await checkQuota(pool, orgA, 'ai_credits', 10 ** 9);
  assert.equal(no.allowed, false);
  assert.equal(no.reason, 'quota-exhausted');
  const unknown = await checkQuota(pool, orgA, 'teleport', 1);
  assert.equal(unknown.allowed, false);
  const snap = await consumeQuota(pool, orgA, 'ai_credits', 1);
  assert.ok(snap.used >= 1);
});

wire('quota: concurrent consumers cannot exceed the grant (race-safe)', async () => {
  const { consumeQuota, orgQuotaSnapshot } = require('../src/billing/quotas');
  // Pin orgB quota to a small window: granted = used + 5.
  const s0 = await orgQuotaSnapshot(pool, orgB);
  const target = s0.used + 5;
  await pool.query(`UPDATE coexistence.organizations SET ai_credits_granted = $2 WHERE id = $1`, [orgB, target]);
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => consumeQuota(pool, orgB, 'ai_credits', 1))
  );
  const wins = results.filter((r) => r.status === 'fulfilled').length;
  const losses = results.filter((r) => r.status === 'rejected').length;
  assert.equal(wins, 5, `exactly 5 debits must win (got ${wins})`);
  assert.equal(losses, 5);
  const s1 = await orgQuotaSnapshot(pool, orgB);
  assert.equal(s1.used, target);
  assert.equal(s1.remaining, 0);
});

wire('recordAiUsage: debits once, duplicate delivery refunds', async () => {
  const { recordAiUsage, orgQuotaSnapshot } = require('../src/billing/quotas');
  // Replenish orgB for a clean window.
  await pool.query(`UPDATE coexistence.organizations SET ai_credits_granted = ai_credits_used + 50 WHERE id = $1`, [orgB]);
  const s0 = await orgQuotaSnapshot(pool, orgB);
  const msgId = `${TAG}-m1`;
  const r1 = await recordAiUsage(pool, {
    organizationId: orgB, agentId: null, contactNumber: '1999',
    inboundMessageId: msgId, model: 'test', tokensIn: 10, tokensOut: 5, costCredits: 3,
  });
  assert.equal(r1.duplicate, false);
  const s1 = await orgQuotaSnapshot(pool, orgB);
  assert.equal(s1.used, s0.used + 3);
  const r2 = await recordAiUsage(pool, {
    organizationId: orgB, inboundMessageId: msgId, costCredits: 3,
  });
  assert.equal(r2.duplicate, true);
  const s2 = await orgQuotaSnapshot(pool, orgB);
  assert.equal(s2.used, s1.used, 'replay must not double-charge');
  const { rows } = await pool.query(
    `SELECT user_id, model, tokens_in, cost_credits FROM coexistence.ai_usage_ledger
      WHERE organization_id = $1 AND inbound_message_id = $2`,
    [orgB, msgId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost_credits, 3);
});

wire('ledger is org-scoped: B usage never debits A', async () => {
  const { recordAiUsage, orgQuotaSnapshot } = require('../src/billing/quotas');
  const a0 = await orgQuotaSnapshot(pool, orgA);
  await recordAiUsage(pool, { organizationId: orgB, inboundMessageId: `${TAG}-m2`, costCredits: 1 });
  const a1 = await orgQuotaSnapshot(pool, orgA);
  assert.equal(a1.used, a0.used);
});

wire('expiry: lapsed trial and period read expired/entitled-false', async () => {
  await pool.query(
    `UPDATE coexistence.billing_subscriptions SET trial_ends_at = NOW() - INTERVAL '1 day'
      WHERE organization_id = $1`,
    [orgB]
  );
  // orgB is active/scale from the webhook test — force a lapsed paid period too.
  await pool.query(
    `UPDATE coexistence.billing_subscriptions
        SET plan = 'starter', status = 'active', current_period_end = NOW() - INTERVAL '1 hour', trial_ends_at = NULL
      WHERE organization_id = $1`,
    [orgB]
  );
  const s = await ownerB.fetch('/api/v1/billing/status');
  assert.equal(s.body.state, 'expired');
  assert.equal(s.body.entitled, false);
  const { checkQuota } = require('../src/billing/quotas');
  const q = await checkQuota(pool, orgB, 'ai_credits', 1);
  assert.equal(q.allowed, false);
  assert.equal(q.reason, 'subscription-expired');
});

wire('cancel: owner cancels (entitlement ends); member cannot', async () => {
  const denied = await memberA.fetch('/api/v1/billing/cancel', { method: 'POST' });
  assert.equal(denied.status, 403);
  const r = await ownerA.fetch('/api/v1/billing/cancel', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'cancelled');
  assert.equal(r.body.entitled, false);
});
