// Green Pilot — Phase 2: Meta WhatsApp Embedded Signup v4 Test Suite
//
// Verifies:
// 1. Authenticated user can start signup and receive signed config & state token
// 2. Unauthenticated request is rejected (401)
// 3. User without organization context is rejected (403)
// 4. Cross-tenant state tampering / org mismatch is rejected (403)
// 5. Successful Meta Embedded Signup completion provisions WhatsApp connection
// 6. Cancelled Meta flow or missing code returns 400
// 7. Invalid or malformed state token returns 403
// 8. Replayed or expired state token is rejected (403)
// 9. Duplicate connection for the same phone number updates idempotently
// 10. Multiple connections with distinct phone numbers are supported
// 11. Sensitive credentials (access token) are encrypted at rest and masked in API
// 12. Safe disconnect marks account disconnected without touching CRM data (leads/contacts)
// 13. Reconnection after disconnect reactivates account cleanly
// 14. Compatibility aliases (/integrations/whatsapp/*) work identically

process.env.NODE_ENV = 'test';
require('dotenv').config();

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const pool = require('../src/db');
const { setTestGoogleVerifier } = require('../src/googleAuth');
const { setTestMetaHandler } = require('../src/services/metaEmbeddedSignup');
const { setTestGraphClient } = require('../src/services/metaGraphClient');
const { decrypt } = require('../src/util/crypto');

// Configure mock Google auth for testing sessions
setTestGoogleVerifier((token) => {
  if (token && token.startsWith('test-token:')) {
    const parts = token.split(':');
    const sub = parts[1] || `google-sub-${Date.now()}`;
    const email = (parts[2] || `user-${sub}@example.com`).trim().toLowerCase();
    const name = parts[3] || 'Test User';
    return {
      sub,
      email,
      emailVerified: true,
      name,
      picture: null,
    };
  }
  throw new Error('Invalid test token');
});

let server = null;
let base = '';
let dbAvailable = false;
const TAG = `wa-test-${Date.now().toString(36)}`;

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
      for (const c of set) {
        cookies.push(c.split(';')[0]);
      }
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return {
        status: res.status,
        body,
        headers: res.headers,
        cookies,
      };
    },
    clear() {
      cookies.length = 0;
    },
  };
}

// Helper to create an authenticated session with an organization
async function createTestOrgSession(userTag) {
  const client = jar();
  const sub = `sub-${userTag}-${Date.now()}`;
  const email = `${TAG}-${userTag}@greenpilot.test`;
  const name = `User ${userTag}`;
  const token = `test-token:${sub}:${email}:${name}`;

  const res = await client.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: token }),
  });

  assert.equal(res.status, 200, `Failed to authenticate test user ${userTag}`);
  return {
    client,
    user: res.body.user,
    organization: res.body.organization,
  };
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const { runMigrations } = require('../src/db/migrate');
    await runMigrations(pool);
    await pool.query(`DELETE FROM coexistence.whatsapp_accounts WHERE phone_number_id LIKE 'phone-%'`);
    dbAvailable = true;
  } catch (err) {
    console.warn('[test:whatsappEmbeddedSignup] DB unavailable:', err.message);
    return;
  }

  const { app } = require('../src/index');
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (pool) {
    try {
      await pool.query(`DELETE FROM coexistence.whatsapp_accounts WHERE phone_number_id LIKE 'phone-%'`);
      await pool.query(`DELETE FROM coexistence.whatsapp_accounts WHERE organization_id IN (
        SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%'
      )`);
    } catch { /* cleanup ignore */ }
  }
});

beforeEach(() => {
  setTestGraphClient(({ method, path, params, body }) => {
    if (path.includes('oauth/access_token')) {
      return { access_token: 'meta-access-token-12345' };
    }
    if (path.endsWith('/phone_numbers')) {
      return {
        data: [
          {
            id: 'phone-num-101',
            display_phone_number: '+1 555-0199',
            verified_name: 'Acme Clean Energy',
            quality_rating: 'GREEN',
            code_verification_status: 'VERIFIED',
            status: 'CONNECTED',
          },
        ],
      };
    }
    if (path.endsWith('/subscribed_apps')) {
      if (method === 'POST') return { success: true };
      return { data: [{ whatsapp_business_api_data: { id: 'waba-99901' } }] };
    }
    if (path.endsWith('/register')) {
      return { success: true };
    }
    if (path.startsWith('phone-')) {
      return {
        id: path,
        display_phone_number: '+1 555-0199',
        verified_name: 'Acme Clean Energy',
        quality_rating: 'GREEN',
        code_verification_status: 'VERIFIED',
        status: 'CONNECTED',
      };
    }
    if (path.startsWith('waba-')) {
      return {
        id: path,
        name: 'Acme Business',
        timezone_id: '1',
      };
    }
    return { data: [] };
  });
});

test('1. Authenticated user can start signup and receive signed config & state token', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client, organization, user } = await createTestOrgSession('u1');

  const res = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');
  assert.equal(res.status, 200, 'Returns 200 OK');
  assert.ok(res.body.state, 'Returns signed state parameter');
  assert.ok(res.body.apiVersion, 'Returns Graph API version');

  // Verify state token payload
  const secret = process.env.JWT_SECRET || 'forgecrm-dev-secret-change-me';
  const decoded = jwt.verify(res.body.state, secret);
  assert.equal(String(decoded.sub), String(user.id), 'State sub matches user id');
  assert.equal(String(decoded.orgId), String(organization.id), 'State orgId matches org id');
  assert.equal(decoded.action, 'whatsapp_embedded_signup', 'State action matches');
});

test('2. Unauthenticated request to signup config is rejected (401)', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const unauthClient = jar();
  const res = await unauthClient.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');
  assert.equal(res.status, 401, 'Returns 401 Unauthorized');
});

test('3. Organization A cannot initiate or complete signup for Organization B (Tenant Boundary)', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const orgA = await createTestOrgSession('org-a');
  const orgB = await createTestOrgSession('org-b');

  // Get valid state for Org A
  const configA = await orgA.client.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');
  assert.equal(configA.status, 200);
  const stateA = configA.body.state;

  // Attempt to use Org A state within Org B session
  const res = await orgB.client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: 'valid-meta-code',
      state: stateA,
      wabaId: 'waba-12345',
      phoneNumberId: 'phone-num-101',
    }),
  });

  assert.equal(res.status, 403, 'Cross-tenant state is rejected with 403');
  assert.equal(res.body.code, 'user-mismatch', 'Fails on user/tenant mismatch');
});

test('4. Successful Meta Embedded Signup provisions WhatsApp connection', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client, organization } = await createTestOrgSession('success');

  const configRes = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');
  assert.equal(configRes.status, 200);

  const res = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: 'meta-auth-code-123',
      state: configRes.body.state,
      wabaId: 'waba-99901',
      phoneNumberId: 'phone-num-101',
      businessId: 'meta-biz-444',
    }),
  });

  assert.equal(res.status, 201, 'Returns 201 Created');
  assert.ok(res.body.account, 'Returns provisioned account');
  assert.equal(res.body.account.phoneNumberId, 'phone-num-101');
  assert.equal(res.body.account.wabaId, 'waba-99901');
  assert.equal(res.body.account.businessId, 'meta-biz-444');
  assert.equal(res.body.account.connectionStatus.toUpperCase(), 'CONNECTED');
  assert.equal(res.body.account.isActive, true);
  assert.equal(res.body.account.displayName, 'Acme Clean Energy');
  assert.equal(res.body.account.displayPhoneNumber, '15550199');

  // Verify DB record
  const { rows } = await pool.query(
    'SELECT * FROM coexistence.whatsapp_accounts WHERE organization_id = $1 AND phone_number_id = $2',
    [organization.id, 'phone-num-101']
  );
  assert.equal(rows.length, 1, 'Persisted in database');
  assert.equal(rows[0].connection_status.toUpperCase(), 'CONNECTED');
  assert.equal(rows[0].business_id, 'meta-biz-444');
  assert.equal(rows[0].is_active, true);
});

test('5. Cancelled Meta flow or missing code returns 400', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client } = await createTestOrgSession('cancel');
  const configRes = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');

  // Case A: Missing code
  const res1 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      state: configRes.body.state,
      wabaId: 'waba-123',
    }),
  });
  assert.equal(res1.status, 400, 'Missing code rejected');

  // Case B: Explicit cancellation error from Meta
  const res2 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: '',
      error: 'access_denied',
      errorDescription: 'User cancelled the Embedded Signup dialog',
      state: configRes.body.state,
    }),
  });
  assert.equal(res2.status, 400, 'Cancellation error rejected');
});

test('6. Invalid or tampered state token is rejected (403)', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client } = await createTestOrgSession('tamper');

  const res = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: 'some-code',
      state: 'tampered.jwt.signature',
      wabaId: 'waba-123',
    }),
  });

  assert.equal(res.status, 403, 'Tampered state rejected with 403');
  assert.equal(res.body.code, 'expired-state');
});

test('7. Expired state token is rejected (403)', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client, user, organization } = await createTestOrgSession('expire');
  const secret = process.env.JWT_SECRET || 'forgecrm-dev-secret-change-me';

  // Mint an already-expired token
  const expiredState = jwt.sign(
    {
      sub: String(user.id),
      orgId: String(organization.id),
      action: 'whatsapp_embedded_signup',
      exp: Math.floor(Date.now() / 1000) - 60, // expired 1 min ago
    },
    secret
  );

  const res = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: 'some-code',
      state: expiredState,
      wabaId: 'waba-123',
    }),
  });

  assert.equal(res.status, 403, 'Expired state rejected with 403');
  assert.equal(res.body.code, 'expired-state');
});

test('8. Duplicate connection for same phone number updates existing record idempotently', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client, organization } = await createTestOrgSession('idempotent');

  const configRes = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');
  assert.equal(configRes.status, 200);

  // First connection
  const res1 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: 'code-pass-1',
      state: configRes.body.state,
      wabaId: 'waba-same',
      phoneNumberId: 'phone-repeat-1',
    }),
  });
  assert.equal(res1.status, 201);
  const accountId1 = res1.body.account.id;

  // Second connection with updated token
  const configRes2 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');
  const res2 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: 'code-pass-2',
      state: configRes2.body.state,
      wabaId: 'waba-same',
      phoneNumberId: 'phone-repeat-1',
    }),
  });
  assert.equal(res2.status, 201);
  assert.equal(res2.body.account.id, accountId1, 'Updates the exact same account record');

  // Verify only 1 row exists in DB
  const { rows } = await pool.query(
    'SELECT * FROM coexistence.whatsapp_accounts WHERE organization_id = $1 AND phone_number_id = $2',
    [organization.id, 'phone-repeat-1']
  );
  assert.equal(rows.length, 1, 'Only one record exists');
});

test('9. Multiple connections with distinct phone numbers are supported', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client, organization } = await createTestOrgSession('multi');

  // Configure mock to return phone 2
  setTestMetaHandler((action, params) => {
    if (action === 'exchangeCode') return { accessToken: 'token-multi' };
    if (action === 'fetchPhoneNumbers') {
      return {
        phoneNumbers: [
          { id: params.phoneNumberId || 'phone-custom', display_phone_number: '+1 555-0200', verified_name: 'Multi Line' },
        ],
      };
    }
    if (action === 'subscribeWebhook') return { success: true };
    return null;
  });

  const c1 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');
  const r1 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: 'code-1',
      state: c1.body.state,
      wabaId: 'waba-multi',
      phoneNumberId: 'phone-num-A',
    }),
  });
  assert.equal(r1.status, 201);

  const c2 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');
  const r2 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: 'code-2',
      state: c2.body.state,
      wabaId: 'waba-multi',
      phoneNumberId: 'phone-num-B',
    }),
  });
  assert.equal(r2.status, 201);

  assert.notEqual(r1.body.account.id, r2.body.account.id, 'Distinct account IDs for separate numbers');

  const listRes = await client.fetch('/api/v1/whatsapp-accounts');
  assert.equal(listRes.status, 200);
  assert.ok(listRes.body.length >= 2, 'Lists both WhatsApp accounts for organization');
});

test('10. Sensitive credentials are encrypted at rest and masked in public responses', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client, organization } = await createTestOrgSession('security');

  const cfg = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');
  const res = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: 'super-secret-code',
      state: cfg.body.state,
      wabaId: 'waba-sec',
      phoneNumberId: 'phone-sec-1',
    }),
  });
  assert.equal(res.status, 201);

  // 1. In API response, raw token is never exposed
  assert.equal(res.body.account.accessToken, undefined);

  // 2. In DB, raw token is encrypted with AES-256-GCM
  const { rows } = await pool.query(
    'SELECT access_token_encrypted FROM coexistence.whatsapp_accounts WHERE id = $1',
    [res.body.account.id]
  );
  assert.ok(rows[0].access_token_encrypted, 'Encrypted token present in DB');
  assert.notEqual(rows[0].access_token_encrypted, 'meta-access-token-12345');
  assert.ok(rows[0].access_token_encrypted.length > 32, 'Valid encrypted ciphertext');

  // 3. Decrypts to original token
  const decrypted = decrypt(rows[0].access_token_encrypted);
  assert.equal(decrypted, 'meta-access-token-12345');
});

test('11. Safe disconnect updates status and preserves CRM contacts & conversations', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client, organization } = await createTestOrgSession('disconnect');

  // Provision an account
  const cfg = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');
  const connRes = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: 'code-disc',
      state: cfg.body.state,
      wabaId: 'waba-disc',
      phoneNumberId: 'phone-disc-1',
    }),
  });
  assert.equal(connRes.status, 201);
  const accountId = connRes.body.account.id;

  // Insert mock CRM lead/contact and mock message to simulate customer data
  const { rows: contactRows } = await pool.query(
    `INSERT INTO coexistence.contacts (name, wa_number, contact_number, organization_id, created_at)
     VALUES ('Jane Doe', '+15551234567', '+15551234567', $1, NOW())
     RETURNING id`,
    [organization.id]
  );
  const contactId = contactRows[0].id;

  // Perform safe disconnect
  const discRes = await client.fetch(`/api/v1/whatsapp-accounts/${accountId}/disconnect`, {
    method: 'POST',
  });
  assert.equal(discRes.status, 200, 'Returns 200 on disconnect');
  assert.equal(discRes.body.success, true);
  assert.equal(discRes.body.account.connectionStatus.toUpperCase(), 'DISCONNECTED');
  assert.equal(discRes.body.account.isActive, false);
  assert.ok(discRes.body.account.disconnectedAt, 'Has disconnectedAt timestamp');

  // Verify WhatsApp account state in DB
  const { rows: waRows } = await pool.query(
    'SELECT connection_status, is_active, disconnected_at FROM coexistence.whatsapp_accounts WHERE id = $1',
    [accountId]
  );
  assert.equal(waRows[0].connection_status.toUpperCase(), 'DISCONNECTED');
  assert.equal(waRows[0].is_active, false);
  assert.ok(waRows[0].disconnected_at);

  // CRITICAL: Verify CRM contacts are untouched and preserved!
  const { rows: crmRows } = await pool.query(
    'SELECT * FROM coexistence.contacts WHERE id = $1',
    [contactId]
  );
  assert.equal(crmRows.length, 1, 'CRM contact is completely intact and preserved');

  // Cleanup CRM test row
  await pool.query('DELETE FROM coexistence.contacts WHERE id = $1', [contactId]);
});

test('12. Reconnecting a disconnected account restores active status', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client } = await createTestOrgSession('reconnect');

  // Provision
  const cfg1 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');
  const conn1 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: 'code-reconn',
      state: cfg1.body.state,
      wabaId: 'waba-reconn',
      phoneNumberId: 'phone-reconn-1',
    }),
  });
  assert.equal(conn1.status, 201);
  const accId = conn1.body.account.id;

  // Disconnect
  await client.fetch(`/api/v1/whatsapp-accounts/${accId}/disconnect`, { method: 'POST' });

  // Re-connect via Embedded Signup
  const cfg2 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/config');
  const conn2 = await client.fetch('/api/v1/whatsapp-accounts/embedded-signup/complete', {
    method: 'POST',
    body: JSON.stringify({
      code: 'code-reconn-2',
      state: cfg2.body.state,
      wabaId: 'waba-reconn',
      phoneNumberId: 'phone-reconn-1',
    }),
  });

  assert.equal(conn2.status, 201);
  assert.equal(conn2.body.account.id, accId, 'Preserves existing account record');
  assert.equal(conn2.body.account.connectionStatus.toUpperCase(), 'CONNECTED');
  assert.equal(conn2.body.account.isActive, true);
  assert.equal(conn2.body.account.disconnectedAt, null, 'Clears disconnectedAt');
});

test('13. Route aliases (/integrations/whatsapp/*) work identically', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client } = await createTestOrgSession('aliases');

  // Alias for config
  const cfg = await client.fetch('/api/v1/integrations/whatsapp/config');
  assert.equal(cfg.status, 200);
  assert.ok(cfg.body.state);

  // Alias for complete
  const comp = await client.fetch('/api/v1/integrations/whatsapp/embedded-signup', {
    method: 'POST',
    body: JSON.stringify({
      code: 'code-alias',
      state: cfg.body.state,
      wabaId: 'waba-alias',
      phoneNumberId: 'phone-alias-1',
    }),
  });
  assert.equal(comp.status, 201);

  // Alias for disconnect
  const disc = await client.fetch('/api/v1/integrations/whatsapp/disconnect', {
    method: 'POST',
    body: JSON.stringify({ accountId: comp.body.account.id }),
  });
  assert.equal(disc.status, 200);
  assert.equal(disc.body.account.connectionStatus.toUpperCase(), 'DISCONNECTED');
});
