'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAdmin, hasPermission, effectivePages,
  OWNER_PAGE_GRANTS, MEMBER_PAGE_GRANTS, mergePageGrants,
} = require('../src/permissions');

test('isAdmin is true only for role "admin"', () => {
  assert.equal(isAdmin({ role: 'admin' }), true);
  assert.equal(isAdmin({ role: 'bda_sales' }), false);
  assert.equal(isAdmin({ role: 'viewer' }), false);
  assert.equal(isAdmin(null), false);
  assert.equal(isAdmin({}), false);
});

test('admin has permission for every page', () => {
  assert.equal(hasPermission({ role: 'admin' }, 'admin-settings:users'), true);
  assert.equal(hasPermission({ role: 'admin' }, 'media-library'), true);
});

test('bda_sales is limited to its default pages', () => {
  const u = { role: 'bda_sales' };
  assert.equal(hasPermission(u, 'chats'), true);
  assert.equal(hasPermission(u, 'contacts'), true);
  // Not granted to sales by default:
  assert.equal(hasPermission(u, 'admin-settings:users'), false);
  assert.equal(hasPermission(u, 'media-library'), false);
});

test('null user has no permissions', () => {
  assert.equal(hasPermission(null, 'home'), false);
});

test('per-user grant/revoke overrides are applied', () => {
  const granted = effectivePages({ role: 'bda_sales', permissions: { grant: ['media-library'] } });
  assert.equal(granted.has('media-library'), true);

  const revoked = effectivePages({ role: 'bda_sales', permissions: { revoke: ['chats'] } });
  assert.equal(revoked.has('chats'), false);
});

test('Phase 12 owner/member grants never include instance-admin surfaces', () => {
  for (const p of [...OWNER_PAGE_GRANTS, ...MEMBER_PAGE_GRANTS]) {
    assert.ok(!['admin-settings:users', 'admin-settings:mcp', 'admin-settings:integrations'].includes(p),
      `${p} must stay instance-admin gated`);
  }
  assert.ok(OWNER_PAGE_GRANTS.includes('chats'));
  assert.ok(OWNER_PAGE_GRANTS.includes('admin-settings:whatsapp-accounts'));
  assert.ok(!MEMBER_PAGE_GRANTS.includes('admin-settings:whatsapp-accounts'));
});

test('mergePageGrants unions additively, dedupes, never removes', () => {
  const merged = mergePageGrants({ grant: ['home'], revoke: [] }, ['home', 'chats']);
  assert.deepEqual([...merged.grant].sort(), ['chats', 'home']);
  assert.deepEqual(merged.revoke, []);
  assert.deepEqual(mergePageGrants(null, ['a']).grant, ['a']);
  assert.deepEqual(mergePageGrants('junk', []).grant, []);
});
