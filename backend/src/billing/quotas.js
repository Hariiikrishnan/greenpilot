// Organization quota enforcement (Phase 8) — backend authority.
//
// Frontend limits are UX hints. THESE functions are the enforcement:
// checkQuota (read-only verdict) and consumeQuota/recordAiUsage (transactional
// debit). Concurrency safety comes from SELECT … FOR UPDATE on the org row +
// a guarded UPDATE (used+n <= granted) — the forbidden read-check-write race
// cannot occur because the check and the write hold the same row lock.

const { BillingError, subscriptionState, ensureSubscription } = require('./subscriptions');

const FEATURES = new Set(['ai_credits']);

async function orgQuotaSnapshot(db, orgId) {
  const { rows } = await db.query(
    `SELECT ai_credits_granted, ai_credits_used
       FROM coexistence.organizations WHERE id = $1`,
    [orgId]
  );
  if (!rows[0]) {
    throw new BillingError('Organization not found', 404);
  }
  const granted = rows[0].ai_credits_granted || 0;
  const used = rows[0].ai_credits_used || 0;
  return { granted, used, remaining: Math.max(0, granted - used) };
}

// Read-only verdict: entitled? enough remaining? Never mutates.
async function checkQuota(db, orgId, feature = 'ai_credits', amount = 1) {
  if (!FEATURES.has(feature)) {
    return { allowed: false, remaining: 0, reason: 'unknown-feature' };
  }
  const need = Math.max(1, Math.floor(Number(amount) || 1));
  const sub = await ensureSubscription(db, orgId);
  const { state, entitled } = subscriptionState(sub);
  if (!entitled) {
    return { allowed: false, remaining: 0, reason: `subscription-${state}`, state };
  }
  const snap = await orgQuotaSnapshot(db, orgId);
  if (snap.remaining < need) {
    return { allowed: false, remaining: snap.remaining, reason: 'quota-exhausted', state };
  }
  return { allowed: true, remaining: snap.remaining, reason: 'ok', state };
}

// Atomic debit of `amount` AI credits. Returns the post-debit snapshot.
// Throws quota-exhausted (403) or subscription-<state> (403) — never partial.
async function consumeQuota(pool, orgId, feature = 'ai_credits', amount = 1) {
  if (!FEATURES.has(feature)) {
    throw new BillingError('Unknown quota feature', 400);
  }
  const need = Math.max(1, Math.floor(Number(amount) || 1));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent consumers on the org row.
    const { rows: orgs } = await client.query(
      `SELECT id FROM coexistence.organizations WHERE id = $1 FOR UPDATE`,
      [orgId]
    );
    if (!orgs[0]) {
      throw new BillingError('Organization not found', 404);
    }
    const sub = await ensureSubscription(client, orgId);
    const { state, entitled } = subscriptionState(sub);
    if (!entitled) {
      throw new BillingError(`Subscription ${state} — AI usage not entitled`, 403, `subscription-${state}`);
    }
    const { rowCount, rows } = await client.query(
      `UPDATE coexistence.organizations
          SET ai_credits_used = ai_credits_used + $2
        WHERE id = $1 AND ai_credits_used + $2 <= ai_credits_granted
        RETURNING ai_credits_granted, ai_credits_used`,
      [orgId, need]
    );
    if (rowCount === 0) {
      throw new BillingError('AI credit quota exhausted', 403, 'quota-exhausted');
    }
    await client.query('COMMIT');
    const granted = rows[0].ai_credits_granted;
    const used = rows[0].ai_credits_used;
    return { granted, used, remaining: Math.max(0, granted - used) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already failed */ }
    throw err;
  } finally {
    client.release();
  }
}

// Phase 9-ready AI usage recorder: idempotent ledger insert + atomic credit
// debit in ONE transaction. Duplicate delivery (same org+inbound_message_id)
// refunds the debit and reports { duplicate: true } — the ledger UNIQUE is
// the dedupe key, not application memory.
/**
 * @param {{connect: Function}} pool
 * @param {{organizationId?: string, userId?: number|null, agentId?: number|null,
 *   contactNumber?: string|null, inboundMessageId?: string, model?: string|null,
 *   tokensIn?: number, tokensOut?: number, costCredits?: number}} [opts]
 */
async function recordAiUsage(pool, {
  organizationId, userId = null, agentId = null, contactNumber = null,
  inboundMessageId, model = null, tokensIn = 0, tokensOut = 0, costCredits = 1,
} = {}) {
  if (!organizationId || !inboundMessageId) {
    throw new Error('organizationId and inboundMessageId are required');
  }
  const cost = Math.max(1, Math.floor(Number(costCredits) || 1));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: orgs } = await client.query(
      `SELECT id FROM coexistence.organizations WHERE id = $1 FOR UPDATE`,
      [organizationId]
    );
    if (!orgs[0]) {
      throw new BillingError('Organization not found', 404);
    }
    const sub = await ensureSubscription(client, organizationId);
    const { state, entitled } = subscriptionState(sub);
    if (!entitled) {
      throw new BillingError(`Subscription ${state} — AI usage not entitled`, 403, `subscription-${state}`);
    }
    const debit = await client.query(
      `UPDATE coexistence.organizations
          SET ai_credits_used = ai_credits_used + $2
        WHERE id = $1 AND ai_credits_used + $2 <= ai_credits_granted`,
      [organizationId, cost]
    );
    if (debit.rowCount === 0) {
      throw new BillingError('AI credit quota exhausted', 403, 'quota-exhausted');
    }
    const { rowCount } = await client.query(
      `INSERT INTO coexistence.ai_usage_ledger
         (organization_id, user_id, agent_id, contact_number,
          inbound_message_id, model, tokens_in, tokens_out, cost_credits)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (organization_id, inbound_message_id) DO NOTHING`,
      [organizationId, userId, agentId, contactNumber, inboundMessageId,
        model, tokensIn | 0, tokensOut | 0, cost]
    );
    if (rowCount === 0) {
      // Replay: refund the debit so retries never double-charge.
      await client.query(
        `UPDATE coexistence.organizations
            SET ai_credits_used = GREATEST(0, ai_credits_used - $2)
          WHERE id = $1`,
        [organizationId, cost]
      );
      await client.query('COMMIT');
      return { duplicate: true };
    }
    await client.query('COMMIT');
    return { duplicate: false, costCredits: cost };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already failed */ }
    throw err;
  } finally {
    client.release();
  }
}

// Read-only duplicate-execution probe: has this org already ledgered this
// message? Lets workers skip re-running the LLM (and re-charging) on
// duplicate webhook/queue delivery without mutating anything.
async function hasAiUsage(db, organizationId, inboundMessageId) {
  if (!organizationId || !inboundMessageId) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM coexistence.ai_usage_ledger
      WHERE organization_id = $1 AND inbound_message_id = $2
      LIMIT 1`,
    [organizationId, inboundMessageId]
  );
  return rows.length > 0;
}

module.exports = { FEATURES, orgQuotaSnapshot, checkQuota, consumeQuota, recordAiUsage, hasAiUsage };

