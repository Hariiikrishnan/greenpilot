// Phase 12 onboarding service — server-persisted, retry-safe onboarding state.
//
// Ownership chain: every read/write is scoped to an explicit organizationId
// that the route layer has already authorized via membership (requireOrg /
// assertMembership). This module never trusts a client-supplied org id.
//
// Steps (only capabilities the product actually supports):
//   organization → whatsapp → team → ai → automation → complete
// Each step reports: status (pending|in-progress|complete), required flag,
// and detail. Completion is derived from REAL backend state — never from a
// client "Continue" click.

const crypto = require('crypto');

// Canonical step ids in display order.
const ONBOARDING_STEPS = ['organization', 'whatsapp', 'team', 'ai', 'automation', 'complete'];

// Steps that MUST be complete before onboarding counts as complete.
// whatsapp/team/ai/automation are discoverable-but-optional: a new customer
// is usable with org + CRM defaults alone.
const REQUIRED_STEPS = ['organization'];

const VALID_ROLES = new Set(['admin', 'member']);

function defaultOnboardingState() {
  return { steps: {}, dismissed: false, version: 1 };
}

function normalizeState(raw) {
  const base = defaultOnboardingState();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.steps && typeof raw.steps === 'object') base.steps = { ...raw.steps };
    if (typeof raw.dismissed === 'boolean') base.dismissed = raw.dismissed;
  }
  return base;
}

// Merge a client step update into stored state. Only known steps, only
// boolean-ish completion hints — real completion is recomputed server-side
// by computeOnboardingStatus(). Throws HttpError-ish {status} on bad input.
function applyStepUpdate(stored, step, patch) {
  if (!ONBOARDING_STEPS.includes(step)) {
    throw Object.assign(new Error(`Unknown onboarding step: ${step}`), { status: 400 });
  }
  if (step === 'complete') {
    throw Object.assign(new Error('Completion is derived server-side'), { status: 400 });
  }
  const next = normalizeState(stored);
  const cur = (next.steps[step] && typeof next.steps[step] === 'object') ? next.steps[step] : {};
  const p = patch && typeof patch === 'object' ? patch : {};
  next.steps[step] = { ...cur };
  if (p.seen !== undefined) next.steps[step].seen = !!p.seen;
  if (p.dismissed !== undefined) next.steps[step].dismissed = !!p.dismissed;
  return next;
}

// --- Invitation tokens -------------------------------------------------------
// Raw token (returned once) + sha256 hex (persisted). Timing-safe compare.
function mintInviteToken() {
  const raw = crypto.randomBytes(32).toString('hex'); // 64 chars
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

function hashInviteToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function inviteTokenEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function validateInviteInput({ email, role }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw Object.assign(new Error('A valid email is required'), { status: 400 });
  }
  if (!VALID_ROLES.has(role)) {
    throw Object.assign(new Error('Role must be admin or member'), { status: 400 });
  }
  return { email: cleanEmail, role };
}

// --- Status computation ------------------------------------------------------
// Reads REAL backend state per org. `db` is pool-or-client with .query.
// Returns { steps: {id: {status, required, detail}}, completed, requiredComplete }.
async function computeOnboardingStatus(db, organizationId) {
  const steps = {};
  // organization: the org row exists (caller already authorized) — complete.
  steps.organization = { status: 'complete', required: true, detail: 'Organization created' };

  // whatsapp: ≥1 account row in scope with is_active.
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.whatsapp_accounts
        WHERE organization_id = $1 AND is_active = TRUE`,
      [organizationId]
    );
    const n = rows[0]?.n || 0;
    steps.whatsapp = n > 0
      ? { status: 'complete', required: false, detail: `${n} WhatsApp number(s) connected` }
      : { status: 'pending', required: false, detail: 'No WhatsApp number connected yet' };
  } catch {
    steps.whatsapp = { status: 'pending', required: false, detail: 'WhatsApp status unavailable' };
  }

  // team: >1 member means the owner invited someone (or was joined).
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.organization_members WHERE organization_id = $1`,
      [organizationId]
    );
    const n = rows[0]?.n || 0;
    steps.team = n > 1
      ? { status: 'complete', required: false, detail: `${n} team members` }
      : { status: 'pending', required: false, detail: 'Only you so far — invite your team' };
  } catch {
    steps.team = { status: 'pending', required: false, detail: 'Team status unavailable' };
  }

  // ai: entitlement + usage from subscriptions/quotas (best-effort; never fake).
  try {
    const { rows } = await db.query(
      `SELECT plan, ai_credits_granted, ai_credits_used FROM coexistence.organizations WHERE id = $1`,
      [organizationId]
    );
    const o = rows[0] || {};
    const granted = Number(o.ai_credits_granted || 0);
    const used = Number(o.ai_credits_used || 0);
    steps.ai = {
      status: granted > used ? 'in-progress' : 'pending',
      required: false,
      detail: granted > 0 ? `${used}/${granted} AI credits used` : `Plan: ${o.plan || 'trial'} — AI usage tracked per plan`,
    };
  } catch {
    steps.ai = { status: 'pending', required: false, detail: 'AI status unavailable' };
  }

  // automation: ≥1 automation row in scope.
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.automations WHERE organization_id = $1`,
      [organizationId]
    );
    const n = rows[0]?.n || 0;
    steps.automation = n > 0
      ? { status: 'complete', required: false, detail: `${n} automation(s) configured` }
      : { status: 'pending', required: false, detail: 'No automations yet — optional' };
  } catch {
    // Legacy table name fallback: automations may live as chatbots in old DBs.
    try {
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM coexistence.chatbots WHERE organization_id = $1`,
        [organizationId]
      );
      const n = rows[0]?.n || 0;
      steps.automation = n > 0
        ? { status: 'complete', required: false, detail: `${n} automation(s) configured` }
        : { status: 'pending', required: false, detail: 'No automations yet — optional' };
    } catch {
      steps.automation = { status: 'pending', required: false, detail: 'Automation status unavailable' };
    }
  }

  // crm defaults: ≥1 pipeline in scope (usable CRM state).
  let crmReady = false;
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.pipelines WHERE organization_id = $1`,
      [organizationId]
    );
    crmReady = (rows[0]?.n || 0) > 0;
  } catch {
    crmReady = false;
  }

  const requiredComplete = REQUIRED_STEPS.every(s => steps[s]?.status === 'complete') && crmReady;
  steps.complete = requiredComplete
    ? { status: 'complete', required: true, detail: 'Onboarding complete' }
    : { status: 'pending', required: true, detail: 'Finish required setup to complete onboarding' };

  return { steps, completed: requiredComplete, crmReady, requiredSteps: REQUIRED_STEPS };
}

// Persist onboarding_state JSONB for an org. Returns the stored state.
async function saveOnboardingState(db, organizationId, state) {
  const next = normalizeState(state);
  await db.query(
    `UPDATE coexistence.organizations SET onboarding_state = $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(next), organizationId]
  );
  return next;
}

async function loadOnboardingState(db, organizationId) {
  const { rows } = await db.query(
    `SELECT onboarding_state, onboarding_completed_at FROM coexistence.organizations WHERE id = $1`,
    [organizationId]
  );
  if (!rows[0]) return { state: defaultOnboardingState(), completedAt: null };
  return { state: normalizeState(rows[0].onboarding_state), completedAt: rows[0].onboarding_completed_at || null };
}

module.exports = {
  ONBOARDING_STEPS,
  REQUIRED_STEPS,
  defaultOnboardingState,
  normalizeState,
  applyStepUpdate,
  mintInviteToken,
  hashInviteToken,
  inviteTokenEqual,
  validateInviteInput,
  computeOnboardingStatus,
  saveOnboardingState,
  loadOnboardingState,
};
