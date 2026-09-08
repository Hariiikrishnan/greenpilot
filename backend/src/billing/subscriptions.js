// Subscription domain logic (Phase 8) — organization-owned, transactional.
//
// All functions take an explicit `db` (pool or client) per the tenancy-layer
// convention. Money/state transitions happen in single transactions with row
// locks so concurrent verify/webhook deliveries cannot double-activate.

const { getPlan } = require('./plans');

// Billing failures carry an HTTP status + machine code for the route layer
// (client-visible message stays safe; provider internals never attached).
class BillingError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'BillingError';
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

// Effective-state computation (pure): stored status + windows vs now. A row
// is NEVER trusted at face value — an `active` row past its period end reads
// as expired without needing a sweeper to rewrite it.
function subscriptionState(sub, now = new Date()) {
  const t = now instanceof Date ? now : new Date(now);
  const status = String(sub?.status || '').toLowerCase();
  const plan = String(sub?.plan || 'trial').toLowerCase();
  const trialEnd = sub?.trial_ends_at ? new Date(sub.trial_ends_at) : null;
  const periodEnd = sub?.current_period_end ? new Date(sub.current_period_end) : null;

  if (status === 'suspended') return { state: 'suspended', entitled: false };
  if (status === 'cancelled') return { state: 'cancelled', entitled: false };
  if (status === 'past_due') return { state: 'past_due', entitled: false };
  if (status === 'expired') return { state: 'expired', entitled: false };
  if (plan === 'trial' || status === 'trialing' || status === 'trial') {
    if (trialEnd && t > trialEnd) return { state: 'expired', entitled: false };
    return { state: 'trialing', entitled: true };
  }
  if (status === 'active') {
    if (periodEnd && t > periodEnd) return { state: 'expired', entitled: false };
    return { state: 'active', entitled: true };
  }
  return { state: 'expired', entitled: false }; // unknown → fail closed
}

async function getSubscription(db, orgId) {
  const { rows } = await db.query(
    `SELECT * FROM coexistence.billing_subscriptions WHERE organization_id = $1`,
    [orgId]
  );
  return rows[0] || null;
}

// Ensure a trial subscription exists (org creation / first billing read).
// Idempotent: concurrent callers collapse on the UNIQUE organization_id.
async function ensureSubscription(db, orgId) {
  const trial = getPlan('trial');
  const { rows } = await db.query(
    `INSERT INTO coexistence.billing_subscriptions
       (organization_id, plan, status, trial_ends_at)
     VALUES ($1, 'trial', 'trialing', NOW() + ($2 || ' days')::interval)
     ON CONFLICT (organization_id) DO NOTHING
     RETURNING *`,
    [orgId, String(trial.trialDays)]
  );
  if (rows[0]) {
    // Fresh trial: seed the evaluation AI grant once (placeholder amount).
    await db.query(
      `UPDATE coexistence.organizations
          SET ai_credits_granted = ai_credits_granted + $2
        WHERE id = $1`,
      [orgId, trial.aiCreditsPerCycle]
    );
    return rows[0];
  }
  return getSubscription(db, orgId);
}

// Atomic, idempotent activation after VERIFIED payment (verify route or
// webhook — both funnel here). Duplicate delivery of the same payment returns
// the current subscription WITHOUT re-granting credits (order paid-transition
// is guarded by WHERE status='created').
async function activateSubscription(pool, { orgId, planId, providerOrderId, providerPaymentId, amountPaise }) {
  const plan = getPlan(planId);
  if (!plan) {
    throw new BillingError('Unknown plan', 400);
  }
  if (amountPaise !== plan.pricePaise) {
    throw new BillingError('Amount does not match plan price', 400, 'amount-mismatch');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Order must exist AND belong to this org — one query answers "wrong
    // order" and "forged org" identically (no cross-tenant probing).
    const { rows: orders } = await client.query(
      `SELECT * FROM coexistence.billing_orders
        WHERE provider_order_id = $1 AND organization_id = $2
        FOR UPDATE`,
      [providerOrderId, orgId]
    );
    const order = orders[0];
    if (!order) {
      throw new BillingError('Order not found for this organization', 404, 'order-not-found');
    }
    if (order.plan !== plan.id || order.amount_paise !== plan.pricePaise) {
      throw new BillingError('Order does not match the requested plan', 400, 'order-plan-mismatch');
    }
    if (order.status === 'paid') {
      await client.query('COMMIT');
      return { subscription: await getSubscription(pool, orgId), alreadyPaid: true };
    }
    if (order.status !== 'created') {
      throw new BillingError(`Order is ${order.status}, cannot activate`, 409, 'order-state');
    }
    // Paid transition is atomic: exactly one concurrent activator wins.
    const { rowCount } = await client.query(
      `UPDATE coexistence.billing_orders
          SET status = 'paid', provider_payment_id = $1, verified_at = NOW(), updated_at = NOW()
        WHERE id = $2 AND status = 'created'`,
      [providerPaymentId, order.id]
    );
    if (rowCount === 0) {
      // Lost the race — the winner already paid it. Idempotent success.
      await client.query('COMMIT');
      return { subscription: await getSubscription(pool, orgId), alreadyPaid: true };
    }
    // Subscription row (may predate billing for old orgs) — lock it.
    await client.query(
      `INSERT INTO coexistence.billing_subscriptions (organization_id, plan, status)
       VALUES ($1, 'trial', 'trialing')
       ON CONFLICT (organization_id) DO NOTHING`,
      [orgId]
    );
    const periodEnd = plan.interval === 'month'
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const { rows: subs } = await client.query(
      `UPDATE coexistence.billing_subscriptions
          SET plan = $1, status = 'active',
              provider = 'razorpay', provider_subscription_id = $2,
              current_period_end = $3, updated_at = NOW()
        WHERE organization_id = $4
        RETURNING *`,
      [plan.id, providerOrderId, periodEnd, orgId]
    );
    // Grant the cycle's AI credits exactly once (inside the winning txn).
    await client.query(
      `UPDATE coexistence.organizations
          SET ai_credits_granted = ai_credits_granted + $2
        WHERE id = $1`,
      [orgId, plan.aiCreditsPerCycle]
    );
    await client.query('COMMIT');
    return { subscription: subs[0], alreadyPaid: false };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already failed */ }
    throw err;
  } finally {
    client.release();
  }
}

async function cancelSubscription(db, orgId) {
  const { rows } = await db.query(
    `UPDATE coexistence.billing_subscriptions
        SET status = 'cancelled', updated_at = NOW()
      WHERE organization_id = $1
      RETURNING *`,
    [orgId]
  );
  return rows[0] || null;
}

async function markOrderFailed(db, providerOrderId, orgId) {
  await db.query(
    `UPDATE coexistence.billing_orders
        SET status = 'failed', updated_at = NOW()
      WHERE provider_order_id = $1 AND organization_id = $2 AND status = 'created'`,
    [providerOrderId, orgId]
  );
}

module.exports = {
  BillingError,
  subscriptionState,
  getSubscription,
  ensureSubscription,
  activateSubscription,
  cancelSubscription,
  markOrderFailed,
};
