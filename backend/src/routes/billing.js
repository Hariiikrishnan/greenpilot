// Green Pilot billing API (Phase 8).
//
// Canonical: /api/v1/billing/* (router also mounts under legacy /api as compat,
// same handlers — see index.js protectedRouters). The organization ALWAYS comes
// from req.org (authenticated membership); client-supplied org ids, prices,
// and entitlements are never trusted. Write operations require the org
// owner/admin membership role (existing role model — no second system).

const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireOrg } = require('../middleware/tenant');
const { publicPlans, getPlan } = require('../billing/plans');
const razorpay = require('../billing/razorpay');
const {
  ensureSubscription,
  activateSubscription,
  cancelSubscription,
  markOrderFailed,
  subscriptionState,
} = require('../billing/subscriptions');
const { orgQuotaSnapshot } = require('../billing/quotas');

const router = Router();

// Billing management = org owner/admin. Reads stay member-visible; every
// write route mounts this after requireOrg.
function requireBillingManager(req, res, next) {
  const role = req.org?.role;
  if (role !== 'owner' && role !== 'admin') {
    return res.status(403).json({ error: 'Billing management requires owner or admin role', code: 'billing-forbidden' });
  }
  return next();
}

function safeError(err) {
  // Provider internals (keys, raw bodies) never reach the client.
  const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = status === 500 ? 'Billing request failed' : (err.message || 'Billing request failed');
  return { status, body: { error: message, ...(err.code ? { code: err.code } : {}) } };
}

// GET /billing/plans — server-controlled catalog (any member).
router.get('/billing/plans', requireOrg, async (req, res) => {
  res.json({ plans: publicPlans(), pricingFinalized: false });
});

// GET /billing/status — current plan/state/usage for req.org (any member).
router.get('/billing/status', requireOrg, async (req, res) => {
  try {
    const sub = await ensureSubscription(pool, req.org.id);
    const { state, entitled } = subscriptionState(sub);
    const usage = await orgQuotaSnapshot(pool, req.org.id);
    const plan = getPlan(sub.plan);
    res.json({
      organizationId: req.org.id,
      plan: sub.plan,
      planName: plan ? plan.name : sub.plan,
      state,
      entitled,
      trialEndsAt: sub.trial_ends_at || null,
      currentPeriodEnd: sub.current_period_end || null,
      usage: { granted: usage.granted, used: usage.used, remaining: usage.remaining },
      canManageBilling: req.org.role === 'owner' || req.org.role === 'admin',
      providerConfigured: razorpay.isConfigured(),
      pricingFinalized: false,
    });
  } catch (err) {
    console.error('[billing] status error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// POST /billing/create-order { plan } — owner/admin. Amount/plan resolved
// server-side from the catalog; the client only names the plan id.
router.post('/billing/create-order', requireOrg, requireBillingManager, async (req, res) => {
  const plan = getPlan(req.body?.plan);
  if (!plan) return res.status(400).json({ error: 'Unknown plan', code: 'unknown-plan' });
  if (plan.id === 'trial') {
    return res.status(400).json({ error: 'Trial plan needs no payment order', code: 'trial-no-order' });
  }
  if (!razorpay.isConfigured()) {
    return res.status(503).json({ error: 'Billing provider is not configured', code: 'billing-unavailable' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize order creation per org: concurrent upgrades share one order
    // instead of minting duplicates at the provider.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing-order:${req.org.id}`]);
    const { rows: existing } = await client.query(
      `SELECT provider_order_id, receipt, plan, amount_paise, currency
         FROM coexistence.billing_orders
        WHERE organization_id = $1 AND plan = $2 AND status = 'created'
          AND created_at > NOW() - INTERVAL '30 minutes'
        ORDER BY created_at DESC LIMIT 1`,
      [req.org.id, plan.id]
    );
    if (existing[0] && existing[0].provider_order_id) {
      await client.query('COMMIT');
      return res.status(200).json({
        reused: true,
        providerOrderId: existing[0].provider_order_id,
        receipt: existing[0].receipt,
        amountPaise: existing[0].amount_paise,
        currency: existing[0].currency,
        plan: plan.id,
        publicKey: razorpay.publicKey(),
      });
    }
    const receipt = `gp_${crypto.randomBytes(12).toString('hex')}`;
    let provider;
    try {
      provider = await razorpay.createProviderOrder({
        amountPaise: plan.pricePaise,
        currency: plan.currency,
        receipt,
        notes: { organization_id: req.org.id, plan: plan.id },
      });
    } catch (pErr) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      console.error('[billing] provider order failed:', pErr.message);
      const { status, body } = safeError(pErr);
      return res.status(status).json(body);
    }
    await client.query(
      `INSERT INTO coexistence.billing_orders
         (organization_id, provider, provider_order_id, receipt, plan, amount_paise, currency, status)
       VALUES ($1, 'razorpay', $2, $3, $4, $5, $6, 'created')`,
      [req.org.id, provider.providerOrderId, receipt, plan.id, provider.amountPaise, provider.currency]
    );
    await client.query('COMMIT');
    return res.status(201).json({
      providerOrderId: provider.providerOrderId,
      receipt,
      amountPaise: provider.amountPaise,
      currency: provider.currency,
      plan: plan.id,
      publicKey: razorpay.publicKey(),
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[billing] create-order error:', err.message);
    const { status, body } = safeError(err);
    return res.status(status).json(body);
  } finally {
    client.release();
  }
});

// POST /billing/verify-payment — owner/admin. The browser callback proves
// NOTHING until the HMAC + amount/plan/order checks pass here.
router.post('/billing/verify-payment', requireOrg, requireBillingManager, async (req, res) => {
  try {
    const { providerOrderId, providerPaymentId, signature } = req.body || {};
    if (!providerOrderId || !providerPaymentId || !signature) {
      return res.status(400).json({ error: 'providerOrderId, providerPaymentId and signature are required' });
    }
    // Order must belong to req.org — wrong-order and forged-org share one 404
    // (no cross-tenant probing).
    const { rows } = await pool.query(
      `SELECT plan, amount_paise, status FROM coexistence.billing_orders
        WHERE provider_order_id = $1 AND organization_id = $2`,
      [providerOrderId, req.org.id]
    );
    const order = rows[0];
    if (!order) {
      return res.status(404).json({ error: 'Order not found for this organization', code: 'order-not-found' });
    }
    const plan = getPlan(order.plan);
    if (!plan || order.amount_paise !== plan.pricePaise) {
      console.error('[billing] verify: order/plan mismatch for org', req.org.id);
      return res.status(400).json({ error: 'Order does not match the requested plan', code: 'order-plan-mismatch' });
    }
    if (!razorpay.verifyPaymentSignature({
      orderId: providerOrderId, paymentId: providerPaymentId, signature,
    })) {
      console.error('[billing] verify: bad signature for org', req.org.id);
      return res.status(403).json({ error: 'Payment signature verification failed', code: 'invalid-signature' });
    }
    const { subscription, alreadyPaid } = await activateSubscription(pool, {
      orgId: req.org.id,
      planId: plan.id,
      providerOrderId,
      providerPaymentId,
      amountPaise: order.amount_paise,
    });
    const { state, entitled } = subscriptionState(subscription);
    const usage = await orgQuotaSnapshot(pool, req.org.id);
    return res.json({
      ok: true,
      alreadyProcessed: !!alreadyPaid, // idempotent replay → current state
      plan: subscription.plan,
      state,
      entitled,
      currentPeriodEnd: subscription.current_period_end,
      usage: { granted: usage.granted, used: usage.used, remaining: usage.remaining },
    });
  } catch (err) {
    console.error('[billing] verify error:', err.message);
    const { status, body } = safeError(err);
    return res.status(status).json(body);
  }
});

// POST /billing/cancel — owner/admin business action (no payment needed).
router.post('/billing/cancel', requireOrg, requireBillingManager, async (req, res) => {
  try {
    await ensureSubscription(pool, req.org.id);
    const sub = await cancelSubscription(pool, req.org.id);
    const { state, entitled } = subscriptionState(sub);
    res.json({ ok: true, plan: sub.plan, state, entitled });
  } catch (err) {
    console.error('[billing] cancel error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// --- Public webhook router (Razorpay → Green Pilot, HMAC-only) --------------
// Mounted WITHOUT auth (like the Meta webhook). The org is resolved from the
// STORED order row keyed by provider_order_id — never from payload content.

const publicRouter = Router();

publicRouter.post('/v1/billing/webhook/razorpay', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!razorpay.verifyWebhookSignature(req.rawBody, signature)) {
      return res.status(403).json({ error: 'Invalid webhook signature' });
    }
    const event = req.body?.event;
    const entity = req.body?.payload?.payment?.entity || req.body?.payload?.order?.entity || {};
    if (event !== 'order.paid' && event !== 'payment.captured' && event !== 'payment.failed') {
      return res.status(200).json({ ok: true, ignored: true }); // validated, not ours
    }
    const providerOrderId = entity.order_id || entity.id;
    const providerPaymentId = entity.id && entity.order_id ? entity.id : (entity.payments?.[0] || null);
    if (!providerOrderId) return res.status(200).json({ ok: true, ignored: true });
    // Org from the stored order — payload notes are untrusted.
    const { rows } = await pool.query(
      `SELECT organization_id, plan, amount_paise, status FROM coexistence.billing_orders
        WHERE provider_order_id = $1`,
      [providerOrderId]
    );
    const order = rows[0];
    if (!order) return res.status(200).json({ ok: true, ignored: true }); // unknown order, ack
    if (event === 'payment.failed') {
      await markOrderFailed(pool, providerOrderId, order.organization_id);
      return res.status(200).json({ ok: true });
    }
    // order.paid / payment.captured → same atomic, idempotent activator as the
    // verify route. Replays collapse on the paid-transition guard.
    const plan = getPlan(order.plan);
    if (!plan || order.amount_paise !== plan.pricePaise) {
      console.error('[billing] webhook: order/plan mismatch, refusing activation');
      return res.status(200).json({ ok: true, ignored: true });
    }
    await activateSubscription(pool, {
      orgId: order.organization_id,
      planId: plan.id,
      providerOrderId,
      providerPaymentId: providerPaymentId || providerOrderId,
      amountPaise: order.amount_paise,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[billing] webhook error:', err.message);
    // Always 200 with a static body (provider retries on non-2xx; err text
    // stays server-side).
    return res.status(200).json({ ok: false, error: 'Processing error' });
  }
});

module.exports = { router, publicRouter };
