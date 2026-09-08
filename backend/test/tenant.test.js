// Green Pilot tenant-isolation tests (pure unit — stubbed db, no Postgres).
//
// Verifies the §5 foundation: org context derives from membership only,
// forged ids fail closed, and webhook/org matching never crosses tenants:
//   Org A (user A, lead/account A) vs Org B (user B, lead/account B).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  slugify,
  listUserOrganizations,
  assertMembership,
  createOrganization,
  resolveTenantContext,
  isOrgWebhookAllowed,
} = require('../src/tenancy/organizations');
const { orgFromMembership } = require('../src/middleware/tenant');

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 1;
const USER_B = 2;

// Minimal stub db: responds to the membership/creation queries used by the service.
function stubDb({ memberships = [], createOrg = null } = {}) {
  return {
    async query(text, params) {
      if (text.includes('FROM coexistence.organization_members m') && text.includes('JOIN coexistence.organizations')) {
        if (params.length === 1) {
          return { rows: memberships.filter(m => m.user_id === params[0]) };
        }
        const hit = memberships.find(m => m.user_id === params[0] && String(m.organization_id) === String(params[1]));
        return { rows: hit ? [hit] : [] };
      }
      if (text.startsWith('INSERT INTO coexistence.organizations')) {
        if (createOrg === 'conflict') {
          throw Object.assign(new Error('duplicate'), { code: '23505' });
        }
        return { rows: [{ id: 'new-org-id', name: params[0], slug: params[1] }] };
      }
      if (text.startsWith('INSERT INTO coexistence.organization_members')) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    },
  };
}

const MEMBERSHIPS = [
  { user_id: USER_A, organization_id: ORG_A, role: 'owner', name: 'A Co', slug: 'a-co', plan: 'trial' },
  { user_id: USER_B, organization_id: ORG_B, role: 'owner', name: 'B Co', slug: 'b-co', plan: 'trial' },
];

test('A cannot resolve B as context (forged org id fails closed)', async () => {
  const db = stubDb({ memberships: MEMBERSHIPS });
  const mine = await listUserOrganizations(db, USER_A);
  assert.equal(mine.length, 1);
  assert.throws(() => resolveTenantContext(mine, ORG_B), /Not a member/);
});

test('A resolves own org implicitly; explicit slug also works', async () => {
  const db = stubDb({ memberships: MEMBERSHIPS });
  const mine = await listUserOrganizations(db, USER_A);
  assert.equal(resolveTenantContext(mine).organization_id, ORG_A);
  assert.equal(resolveTenantContext(mine, 'a-co').organization_id, ORG_A);
});

test('user with no orgs fails closed (no-organization)', () => {
  assert.throws(() => resolveTenantContext([]), /No organization membership/);
});

test('multi-org user must choose (ambiguous), forged choice rejected', () => {
  const both = [...MEMBERSHIPS.map(m => ({ ...m, user_id: 9 }))];
  assert.throws(() => resolveTenantContext(both), /Multiple organizations/);
  assert.throws(() => resolveTenantContext(both, 'nope'), /Not a member/);
  assert.equal(resolveTenantContext(both, ORG_B).organization_id, ORG_B);
});

test('assertMembership returns null cross-tenant (A × B)', async () => {
  const db = stubDb({ memberships: MEMBERSHIPS });
  assert.equal(await assertMembership(db, USER_A, ORG_B), null);
  assert.equal((await assertMembership(db, USER_A, ORG_A)).organization_id, ORG_A);
  assert.equal(await assertMembership(db, USER_A, null), null);
});

test('createOrganization validates + returns org (creator becomes owner via member insert)', async () => {
  const db = stubDb({});
  await assert.rejects(createOrganization(db, USER_A, { name: '  ' }), /name is required/);
  const org = await createOrganization(db, USER_A, { name: 'Acme' });
  assert.equal(org.name, 'Acme');
  assert.match(org.slug, /^acme-/);
});

test('orgFromMembership exposes only safe context fields', () => {
  const ctx = orgFromMembership(MEMBERSHIPS[0]);
  assert.deepEqual(Object.keys(ctx).sort(), ['id', 'name', 'plan', 'role', 'slug']);
  assert.equal(ctx.id, ORG_A);
  assert.equal(orgFromMembership(null), null);
});

test('webhook org matching: same-org + legacy allowed; cross-org + unknown denied', () => {
  assert.equal(isOrgWebhookAllowed(ORG_A, ORG_A), true); // Org A → WhatsApp A
  assert.equal(isOrgWebhookAllowed(null, ORG_A), true); // legacy unassigned (dual-read)
  assert.equal(isOrgWebhookAllowed(ORG_B, ORG_A), false); // Org B account on A's route
  assert.equal(isOrgWebhookAllowed(undefined, ORG_A), false); // unknown number
});

test('slugify never yields empty/invalid slugs', () => {
  assert.match(slugify('Acme Inc!'), /^[a-z0-9][a-z0-9-]{1,62}$/);
  assert.match(slugify('!!!'), /^[a-z0-9][a-z0-9-]{1,62}$/);
  assert.match(slugify(''), /^[a-z0-9][a-z0-9-]{1,62}$/);
});
