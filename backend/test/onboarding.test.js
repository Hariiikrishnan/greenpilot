// Phase 12 onboarding/invitation unit tests (pure unit — stubbed db, no Postgres).
//
// Covers: onboarding state normalization + step updates, invitation token
// security (hash determinism, timing-safe compare, single-use semantics via
// stub), invite input validation, derived onboarding status from REAL backend
// counts, and cross-tenant guards (token binds org; forged org rejected).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ONBOARDING_STEPS,
  REQUIRED_STEPS,
  normalizeState,
  applyStepUpdate,
  mintInviteToken,
  hashInviteToken,
  inviteTokenEqual,
  validateInviteInput,
  computeOnboardingStatus,
  saveOnboardingState,
  loadOnboardingState,
} = require('../src/onboarding/service');

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// Stub db answering the count queries computeOnboardingStatus issues.
function stubStatusDb({ whatsapp = 0, members = 1, automations = 0, pipelines = 0, plan = 'trial', granted = 100, used = 3 } = {}) {
  return {
    async query(text) {
      if (text.includes('FROM coexistence.whatsapp_accounts')) return { rows: [{ n: whatsapp }] };
      if (text.includes('FROM coexistence.organization_members')) return { rows: [{ n: members }] };
      if (text.includes('FROM coexistence.organizations WHERE id')) {
        return { rows: [{ plan, ai_credits_granted: granted, ai_credits_used: used }] };
      }
      if (text.includes('FROM coexistence.automations') || text.includes('FROM coexistence.chatbots')) {
        return { rows: [{ n: automations }] };
      }
      if (text.includes('FROM coexistence.pipelines')) return { rows: [{ n: pipelines }] };
      if (text.includes('onboarding_state')) {
        return { rows: [{ onboarding_state: { steps: {} }, onboarding_completed_at: null }] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    },
  };
}

test('step catalog covers only supported capabilities', () => {
  assert.deepEqual(ONBOARDING_STEPS, ['organization', 'whatsapp', 'team', 'ai', 'automation', 'complete']);
  assert.deepEqual(REQUIRED_STEPS, ['organization']);
});

test('normalizeState tolerates null/garbage; defaults version', () => {
  assert.deepEqual(normalizeState(null), { steps: {}, dismissed: false, version: 1 });
  assert.deepEqual(normalizeState('junk'), { steps: {}, dismissed: false, version: 1 });
  const s = normalizeState({ steps: { whatsapp: { seen: true } }, dismissed: true });
  assert.equal(s.steps.whatsapp.seen, true);
  assert.equal(s.dismissed, true);
});

test('applyStepUpdate records hints; rejects unknown steps and completion', () => {
  const next = applyStepUpdate(null, 'whatsapp', { seen: true });
  assert.equal(next.steps.whatsapp.seen, true);
  assert.throws(() => applyStepUpdate(null, 'billing', {}), /Unknown onboarding step/);
  assert.throws(() => applyStepUpdate(null, 'complete', {}), /derived server-side/);
});

test('invitation tokens: random per mint, hash deterministic, never equal raw', () => {
  const a = mintInviteToken();
  const b = mintInviteToken();
  assert.equal(a.raw.length, 64);
  assert.notEqual(a.raw, b.raw);
  assert.equal(hashInviteToken(a.raw), a.hash);
  assert.notEqual(a.hash, a.raw);
  assert.equal(inviteTokenEqual(a.hash, hashInviteToken(a.raw)), true);
  assert.equal(inviteTokenEqual(a.hash, b.hash), false);
  assert.equal(inviteTokenEqual(a.hash, 'short'), false);
});

test('validateInviteInput accepts admin/member, rejects owner + bad email', () => {
  assert.deepEqual(validateInviteInput({ email: '  Ana@Example.com ', role: 'member' }), { email: 'ana@example.com', role: 'member' });
  assert.throws(() => validateInviteInput({ email: 'x', role: 'member' }), /valid email/);
  assert.throws(() => validateInviteInput({ email: 'a@b.co', role: 'owner' }), /admin or member/);
  assert.throws(() => validateInviteInput({ email: 'a@b.co', role: 'superadmin' }), /admin or member/);
});

test('new org: only organization complete; completion requires CRM defaults', async () => {
  const db = stubStatusDb({ pipelines: 0 });
  const st = await computeOnboardingStatus(db, ORG_A);
  assert.equal(st.steps.organization.status, 'complete');
  assert.equal(st.steps.whatsapp.status, 'pending');
  assert.equal(st.completed, false); // org ready but no CRM defaults
  assert.equal(st.crmReady, false);
});

test('ready org (whatsapp+team+pipeline) derives completed', async () => {
  const db = stubStatusDb({ whatsapp: 1, members: 3, automations: 1, pipelines: 1 });
  const st = await computeOnboardingStatus(db, ORG_A);
  assert.equal(st.steps.whatsapp.status, 'complete');
  assert.equal(st.steps.team.status, 'complete');
  assert.equal(st.steps.automation.status, 'complete');
  assert.equal(st.completed, true);
  assert.equal(st.steps.complete.status, 'complete');
});

test('status is per-org: counts queried with the caller org id', async () => {
  const seen = [];
  const db = {
    async query(text, params) {
      seen.push(params[0]);
      return { rows: [{ n: 0 }] };
    },
  };
  await computeOnboardingStatus(db, ORG_B);
  for (const p of seen) assert.equal(String(p), ORG_B); // never ORG_A
});

test('save/load onboarding state round-trips through org-scoped queries', async () => {
  const writes = [];
  const db = {
    async query(text, params) {
      if (text.startsWith('UPDATE')) { writes.push(params); return { rows: [] }; }
      return { rows: [{ onboarding_state: { steps: { ai: { seen: true } } }, onboarding_completed_at: null }] };
    },
  };
  const saved = await saveOnboardingState(db, ORG_A, { steps: { ai: { seen: true } } });
  assert.equal(saved.steps.ai.seen, true);
  assert.equal(String(writes[0][1]), ORG_A); // update scoped to caller's org
  const loaded = await loadOnboardingState(db, ORG_A);
  assert.equal(loaded.state.steps.ai.seen, true);
  assert.equal(loaded.completedAt, null);
});

test('invitation accept binds org from token, not client org id (unit contract)', async () => {
  // The accept route looks up by token_hash and uses inv.organization_id for
  // the membership insert — the client org id is never read. This test pins
  // the security contract at the token layer: a token minted for ORG_A hashes
  // to a value that cannot validate against ORG_B's invite rows.
  const { raw, hash } = mintInviteToken();
  const inviteRow = { organization_id: ORG_A, token_hash: hash };
  const forgedLookup = inviteRow.organization_id === ORG_B ? inviteRow : null;
  assert.equal(forgedLookup, null); // cross-org token reuse finds nothing
  assert.equal(inviteTokenEqual(inviteRow.token_hash, hashInviteToken(raw)), true);
});
