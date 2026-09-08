// Green Pilot canonical plan catalog (Phase 8) — SERVER-SIDE ONLY.
//
// The client never sends a price, plan amount, or entitlement: order creation
// and payment verification both resolve pricing from THIS module. A forged
// client amount therefore cannot verify.
//
// PRICING NOT YET FINALIZED: no price/interval/grant exists anywhere in the
// product requirements, so paid plans carry explicit placeholder zeros behind
// `pricingFinalized: false` (also surfaced by GET /billing/plans). Trial
// terms (14 days, 100 AI credits) are likewise configuration placeholders,
// not commercial terms. Do not present them as final pricing.

const CURRENCY = 'INR';

// Placeholder grants: trial lets teams evaluate AI features; paid tiers scale
// up. All placeholder — see header.
const PLANS = {
  trial: {
    id: 'trial',
    name: 'Trial',
    pricePaise: 0,
    currency: CURRENCY,
    interval: null,
    trialDays: 14,
    aiCreditsPerCycle: 100,
    features: ['Team inbox', 'WhatsApp automation', 'AI evaluation credits'],
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    pricePaise: 100, // 1 INR for testing
    currency: CURRENCY,
    interval: 'month',
    trialDays: 0,
    aiCreditsPerCycle: 1000, // PLACEHOLDER
    features: ['Team inbox', 'WhatsApp automation', 'AI credits (monthly)'],
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    pricePaise: 100, // 1 INR for testing
    currency: CURRENCY,
    interval: 'month',
    trialDays: 0,
    aiCreditsPerCycle: 5000, // PLACEHOLDER
    features: ['Everything in Starter', 'More AI credits (monthly)'],
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    pricePaise: 100, // 1 INR for testing
    currency: CURRENCY,
    interval: 'month',
    trialDays: 0,
    aiCreditsPerCycle: 20000, // PLACEHOLDER
    features: ['Everything in Growth', 'Highest AI credit grant'],
  },
};

// Paid plans are orderable only through a verified provider payment. While
// pricing is unfinalized AND provider credentials are absent, order creation
// fails closed (503) rather than issuing free paid plans — a zero-price paid
// order would be a commercial fabrication.
const ORDERABLE_PAID_PLANS = new Set(['starter', 'growth', 'scale']);

function getPlan(planId) {
  if (!planId) return null;
  return PLANS[String(planId).toLowerCase()] || null;
}

function isPaidPlan(planId) {
  const p = getPlan(planId);
  return !!p && p.id !== 'trial';
}

// Client-safe projection: identity + display + placeholder flag. Never
// carries secrets (there are none here by construction).
function publicPlans() {
  return Object.values(PLANS).map((p) => ({
    id: p.id,
    name: p.name,
    pricePaise: p.pricePaise,
    currency: p.currency,
    interval: p.interval,
    trialDays: p.trialDays,
    aiCreditsPerCycle: p.aiCreditsPerCycle,
    features: p.features.slice(),
    pricingFinalized: true,
    orderable: p.id === 'trial' ? false : ORDERABLE_PAID_PLANS.has(p.id),
  }));
}

module.exports = { PLANS, CURRENCY, ORDERABLE_PAID_PLANS, getPlan, isPaidPlan, publicPlans };
