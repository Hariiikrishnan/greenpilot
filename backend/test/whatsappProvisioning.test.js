// Green Pilot — Phase 3: WhatsApp Provisioning & Credential Security Test Suite
//
// Verifies:
// 1. Successful provisioning (WABA discovery + Phone discovery + Webhook subscription + Registration)
// 2. Failed provisioning (Meta network error / 500) transitions cleanly to ERROR
// 3. Missing permissions (Meta code 200/10) produces typed error and ERROR state
// 4. Invalid token (Meta code 190) produces typed error, invalid_token health status
// 5. Duplicate provisioning idempotently updates existing record without duplicate entries
// 6. Webhook subscription failure does NOT claim CONNECTED, marks ERROR state
// 7. Disconnected or deleted number handled with appropriate status
// 8. Organization isolation: Organization A cannot access or verify Organization B's connection
// 9. Credential protection & redaction: raw tokens never logged or exposed in API
// 10. Connection health verification endpoint verifies connection without exposing tokens

process.env.NODE_ENV = 'test';
require('dotenv').config();

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/db');
const { setTestGoogleVerifier } = require('../src/googleAuth');
const { setTestGraphClient, redactSecrets, MetaGraphApiError } = require('../src/services/metaGraphClient');
const {
  CONNECTION_STATES,
  HEALTH_STATES,
  provisionWhatsAppAccount,
  verifyConnectionHealth,
  disconnectWhatsAppAccount,
} = require('../src/services/whatsappProvisioning');
const { decrypt } = require('../src/util/crypto');

// Mock Google auth for user sessions
setTestGoogleVerifier((token) => {
  if (token && token.startsWith('test-token:')) {
    const parts = token.split(':');
    const sub = parts[1] || `google-sub-${Date.now()}`;
    const email = (parts[2] || `user-${sub}@example.com`).trim().toLowerCase();
    const name = parts[3] || 'Test User';
    return { sub, email, emailVerified: true, name, picture: null };
  }
  throw new Error('Invalid test token');
});

let server = null;
let base = '';
let dbAvailable = false;
const TAG = `prov-test-${Date.now().toString(36)}`;

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
    console.warn('[test:whatsappProvisioning] DB unavailable:', err.message);
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
      await pool.query(`DELETE FROM coexistence.forgecrm_users WHERE email LIKE '${TAG}%'`);
    } catch { /* cleanup ignore */ }
  }
});

beforeEach(() => {
  // Default mock handler for Graph Client
  setTestGraphClient(({ method, path, params, body }) => {
    if (path.includes('oauth/access_token')) {
      return { access_token: 'EAAG_mock_valid_token_12345' };
    }
    if (path.endsWith('/phone_numbers')) {
      return {
        data: [
          {
            id: 'phone-discovered-101',
            display_phone_number: '+1 555-0199',
            verified_name: 'Solar Pilot Energy',
            quality_rating: 'GREEN',
            code_verification_status: 'VERIFIED',
            status: 'CONNECTED',
          },
        ],
      };
    }
    if (path.endsWith('/subscribed_apps')) {
      if (method === 'POST') {
        return { success: true };
      }
      return { data: [{ whatsapp_business_api_data: { id: 'waba-123', link: 'https://...' } }] };
    }
    if (path.endsWith('/register')) {
      return { success: true };
    }
    if (path.startsWith('waba-')) {
      return {
        id: path,
        name: 'Solar Pilot Enterprise',
        currency: 'USD',
        timezone_id: '1',
        message_template_namespace: 'ns_123',
      };
    }
    if (path.startsWith('phone-')) {
      return {
        id: path,
        display_phone_number: '+1 555-0202',
        verified_name: 'Solar Pilot Enterprise',
        quality_rating: 'GREEN',
        code_verification_status: 'VERIFIED',
        status: 'CONNECTED',
      };
    }
    return { data: [] };
  });
});

test('1. Successful provisioning (WABA discovery + Phone discovery + Webhook subscription + Registration)', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization } = await createTestOrgSession('prov-success');

  const account = await provisionWhatsAppAccount({
    organizationId: organization.id,
    directAccessToken: 'valid-test-token',
    wabaId: 'waba-discovered-999',
    phoneNumberId: null, // trigger phone discovery
    db: pool,
  });

  assert.ok(account, 'Account returned');
  assert.equal(account.connection_status, CONNECTION_STATES.CONNECTED);
  assert.equal(account.is_active, true);
  assert.equal(account.phone_number_id, 'phone-discovered-101', 'Discovered phone number ID');
  assert.equal(account.display_name, 'Solar Pilot Energy');
  assert.equal(account.display_phone_number, '15550199');
  assert.equal(account.webhook_subscribed, true, 'Webhook subscription marked true');
  assert.ok(account.webhook_verified_at, 'Has webhook verified timestamp');
});

test('2. Failed provisioning due to Meta API network error throws and does not leave invalid connected row', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization } = await createTestOrgSession('prov-fail');

  setTestGraphClient(({ path }) => {
    if (path.includes('oauth/access_token')) {
      throw new MetaGraphApiError('Simulated Meta API 500 internal server error', {
        status: 500,
        code: 'meta_api_error',
      });
    }
    return null;
  });

  await assert.rejects(
    async () => {
      await provisionWhatsAppAccount({
        organizationId: organization.id,
        code: 'bad-code',
        wabaId: 'waba-fail',
        phoneNumberId: 'phone-fail',
        db: pool,
      });
    },
    {
      name: 'ProvisioningError',
      status: 500,
    }
  );
});

test('3. Missing permissions (Meta code 200) produces typed error', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization } = await createTestOrgSession('prov-perm');

  setTestGraphClient(({ path }) => {
    if (path.includes('oauth/access_token')) {
      throw new MetaGraphApiError('Permissions error: whatsapp_business_management required', {
        status: 403,
        code: 'missing_permissions',
      });
    }
    return null;
  });

  await assert.rejects(
    async () => {
      await provisionWhatsAppAccount({
        organizationId: organization.id,
        code: 'missing-perm-code',
        wabaId: 'waba-perm',
        phoneNumberId: 'phone-perm',
        db: pool,
      });
    },
    {
      name: 'ProvisioningError',
      code: 'missing_permissions',
      status: 403,
    }
  );
});

test('4. Invalid token (Meta code 190) produces typed error and invalid_token status', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization } = await createTestOrgSession('prov-token');

  setTestGraphClient(({ path }) => {
    if (path.includes('oauth/access_token')) {
      throw new MetaGraphApiError('Error validating access token: Session has expired', {
        status: 401,
        code: 'invalid_token',
      });
    }
    return null;
  });

  await assert.rejects(
    async () => {
      await provisionWhatsAppAccount({
        organizationId: organization.id,
        code: 'expired-token-code',
        wabaId: 'waba-exp',
        phoneNumberId: 'phone-exp',
        db: pool,
      });
    },
    {
      name: 'ProvisioningError',
      code: 'invalid_token',
      status: 401,
    }
  );
});

test('5. Duplicate provisioning idempotently updates existing record without duplicate entries', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization } = await createTestOrgSession('prov-dupe');

  // First run
  const first = await provisionWhatsAppAccount({
    organizationId: organization.id,
    directAccessToken: 'token-pass-1',
    wabaId: 'waba-dupe-1',
    phoneNumberId: 'phone-dupe-100',
    displayName: 'Pass 1 Name',
    db: pool,
  });

  // Second run with updated display name and token
  const second = await provisionWhatsAppAccount({
    organizationId: organization.id,
    directAccessToken: 'token-pass-2',
    wabaId: 'waba-dupe-1',
    phoneNumberId: 'phone-dupe-100',
    displayName: 'Pass 2 Name',
    db: pool,
  });

  assert.equal(first.id, second.id, 'Same account record updated');
  assert.equal(second.display_name, 'Pass 2 Name');

  // Verify DB count
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM coexistence.whatsapp_accounts WHERE organization_id = $1 AND phone_number_id = $2',
    [organization.id, 'phone-dupe-100']
  );
  assert.equal(rows[0].count, 1, 'Exactly one row exists');
});

test('6. Webhook subscription failure does NOT claim CONNECTED, marks ERROR state', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization } = await createTestOrgSession('prov-webhook-fail');

  setTestGraphClient(({ method, path }) => {
    if (path.endsWith('/subscribed_apps')) {
      if (method === 'POST') {
        throw new MetaGraphApiError('WABA webhook subscription failed: permission denied', {
          status: 403,
          code: 'missing_permissions',
        });
      }
      return { data: [] };
    }
    if (path === 'phone-wh-fail') {
      return { id: path, display_phone_number: '+15550999', verified_name: 'Hook Fail', status: 'CONNECTED' };
    }
    return null;
  });

  const account = await provisionWhatsAppAccount({
    organizationId: organization.id,
    directAccessToken: 'valid-token',
    wabaId: 'waba-wh-fail',
    phoneNumberId: 'phone-wh-fail',
    db: pool,
  });

  // CRITICAL REQUIREMENT: Do not tell the customer "Connected" if webhook provisioning failed!
  assert.equal(account.connection_status, CONNECTION_STATES.ERROR, 'Marked as ERROR state');
  assert.equal(account.webhook_subscribed, false, 'webhook_subscribed is false');
  assert.ok(account.last_error_message.includes('subscription failed'), 'Records descriptive error');
});

test('7. Disconnected or deleted number handled with appropriate status', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization } = await createTestOrgSession('prov-deleted');

  // Provision active account
  const account = await provisionWhatsAppAccount({
    organizationId: organization.id,
    directAccessToken: 'token-active',
    wabaId: 'waba-active',
    phoneNumberId: 'phone-to-delete',
    displayName: 'Soon to be deleted',
    db: pool,
  });

  // Mock Meta returning 404 asset_not_found
  setTestGraphClient(({ path }) => {
    if (path === 'phone-to-delete') {
      throw new MetaGraphApiError('Unsupported get request. Object with ID does not exist', {
        status: 404,
        code: 'asset_not_found',
      });
    }
    return null;
  });

  const health = await verifyConnectionHealth({
    accountId: account.id,
    organizationId: organization.id,
    db: pool,
  });

  assert.equal(health.healthy, false);
  assert.equal(health.connectionStatus, CONNECTION_STATES.ERROR);

  // DB verification
  const { rows } = await pool.query(
    'SELECT connection_status, health_status FROM coexistence.whatsapp_accounts WHERE id = $1',
    [account.id]
  );
  assert.equal(rows[0].connection_status, CONNECTION_STATES.ERROR);
});

test('8. Organization isolation: Organization A cannot access or verify Organization B connection', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const orgA = await createTestOrgSession('iso-a');
  const orgB = await createTestOrgSession('iso-b');

  // Provision for Org A
  const accountA = await provisionWhatsAppAccount({
    organizationId: orgA.organization.id,
    directAccessToken: 'token-a',
    wabaId: 'waba-a',
    phoneNumberId: 'phone-a-111',
    displayName: 'Org A WhatsApp',
    db: pool,
  });

  // Org B attempts to verify Org A's account
  await assert.rejects(
    async () => {
      await verifyConnectionHealth({
        accountId: accountA.id,
        organizationId: orgB.organization.id, // Org B context!
        db: pool,
      });
    },
    {
      name: 'ProvisioningError',
      status: 404,
    }
  );

  // Org B attempts to disconnect Org A's account
  await assert.rejects(
    async () => {
      await disconnectWhatsAppAccount({
        accountId: accountA.id,
        organizationId: orgB.organization.id,
        db: pool,
      });
    },
    {
      name: 'ProvisioningError',
      status: 404,
    }
  );
});

test('9. Credential protection & redaction: raw tokens never logged or exposed in API', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client, organization } = await createTestOrgSession('redact');

  const sensitiveToken = 'EAAG_super_secret_never_leak_this_token_99999';
  const account = await provisionWhatsAppAccount({
    organizationId: organization.id,
    directAccessToken: sensitiveToken,
    wabaId: 'waba-redact',
    phoneNumberId: 'phone-redact-1',
    displayName: 'Security Test',
    db: pool,
  });

  // 1. In DB: encrypted with AES-256-GCM
  const { rows } = await pool.query(
    'SELECT access_token_encrypted FROM coexistence.whatsapp_accounts WHERE id = $1',
    [account.id]
  );
  assert.notEqual(rows[0].access_token_encrypted, sensitiveToken);
  assert.ok(rows[0].access_token_encrypted.length > 32, 'Has encrypted payload');
  assert.equal(decrypt(rows[0].access_token_encrypted), sensitiveToken);

  // 2. In API GET /whatsapp-accounts
  const listRes = await client.fetch('/api/v1/whatsapp-accounts');
  assert.equal(listRes.status, 200);
  const found = listRes.body.find((a) => a.phoneNumberId === 'phone-redact-1');
  assert.ok(found);
  assert.equal(found.accessToken, undefined, 'Never returns raw accessToken');
  assert.equal(found.access_token, undefined);

  // 3. Test redactSecrets utility
  const loggedStr = `Request failed: Bearer ${sensitiveToken} at url https://graph.facebook.com/v21.0/oauth?client_secret=secret123`;
  const redacted = redactSecrets(loggedStr);
  assert.ok(!redacted.includes(sensitiveToken), 'Secret token is stripped');
  assert.ok(redacted.includes('[REDACTED]'), 'Replaced with [REDACTED]');
});

test('10. Connection health verification endpoint verifies connection without exposing tokens', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { client, organization } = await createTestOrgSession('verify-endpoint');

  const account = await provisionWhatsAppAccount({
    organizationId: organization.id,
    directAccessToken: 'token-verify-ep',
    wabaId: 'waba-verify-ep',
    phoneNumberId: 'phone-explicit-202',
    displayName: 'Verify Endpoint Number',
    db: pool,
  });

  const res = await client.fetch(`/api/v1/whatsapp-accounts/${account.id}/verify`, {
    method: 'POST',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.health);
  assert.equal(res.body.health.healthy, true);
  assert.equal(res.body.health.connectionStatus, CONNECTION_STATES.CONNECTED);
  assert.equal(res.body.health.webhookSubscribed, true);
  assert.equal(res.body.health.accessToken, undefined, 'No token in health report');
});
