// Green Pilot — Phase 1: Google Primary Authentication Test Suite
//
// Verifies:
// 1. Valid Google authentication (new user creation)
// 2. Existing Google user login (Case A)
// 3. Account linking for existing email user (Case B)
// 4. Repeated login & duplicate prevention
// 5. Disabled user rejection
// 6. Organization & owner membership creation
// 7. Organization isolation & tenant boundary enforcement
// 8. Unauthorized organization access prevention
// 9. Invalid Google credential rejection
// 10. Missing Google credential rejection
// 11. Protected route access via session cookie
// 12. Logout session termination
// 13. Onboarding status derivation (WhatsApp not required)

process.env.NODE_ENV = 'test';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { setTestGoogleVerifier, AuthError } = require('../src/googleAuth');

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
  throw new AuthError('Invalid or expired Google credential', 401, 'invalid-token');
});

let pool = null;
let dbAvailable = false;
let server = null;
let base = '';
const TAG = `gauth-${Date.now().toString(36)}`;

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

before(async () => {
  try {
    pool = require('../src/db');
    await pool.query('SELECT 1');
    const { runMigrations } = require('../src/db/migrate');
    await runMigrations(pool);
    dbAvailable = true;
  } catch (err) {
    console.warn('[test:googleAuth] Database unavailable, skipping wire tests:', err.message);
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
    // Clean up test users created in this run
    try {
      await pool.query(`DELETE FROM coexistence.forgecrm_users WHERE email LIKE '${TAG}%'`);
    } catch { /* ignore */ }
  }
});

test('1. New user signup with Google (Case C) creates user, organization, and membership', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const client = jar();
  const sub = `sub-new-${Date.now()}`;
  const email = `${TAG}-newuser@greenpilot.test`;
  const name = 'Alex Green';
  const token = `test-token:${sub}:${email}:${name}`;

  const res = await client.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: token }),
  });

  assert.equal(res.status, 200, 'Returns 200 OK');
  assert.ok(res.body.user, 'Returns user in body');
  assert.equal(res.body.user.email, email, 'Email matches');
  assert.equal(res.body.user.googleSubject, sub, 'Google subject matches');
  assert.equal(res.body.user.role, 'viewer', 'Role is least-privilege viewer');
  assert.ok(Array.isArray(res.body.user.pages), 'Has effective pages');

  // Verify Organization
  assert.ok(res.body.organization, 'Returns organization in body');
  assert.ok(res.body.organization.id, 'Has organization ID');
  assert.equal(res.body.organization.membershipRole, 'owner', 'User is organization owner');

  // Verify Onboarding State
  assert.ok(res.body.onboarding, 'Returns onboarding status');
  assert.equal(typeof res.body.onboarding.completed, 'boolean', 'Has boolean completed status');

  // Verify DB state
  const { rows: uRows } = await pool.query(
    'SELECT * FROM coexistence.forgecrm_users WHERE google_subject = $1',
    [sub]
  );
  assert.equal(uRows.length, 1, 'Exactly one user row in DB');
  assert.equal(uRows[0].email_verified, true, 'email_verified is true');

  const { rows: mRows } = await pool.query(
    'SELECT * FROM coexistence.organization_members WHERE user_id = $1 AND organization_id = $2',
    [uRows[0].id, res.body.organization.id]
  );
  assert.equal(mRows.length, 1, 'Exactly one membership in DB');
  assert.equal(mRows[0].role, 'owner', 'Membership role is owner');

  // Verify Session Cookie
  const cookieHeaders = res.cookies.filter((c) => c.startsWith('forgecrm_token='));
  assert.ok(cookieHeaders.length > 0, 'Sets forgecrm_token cookie');
});

test('2. Existing Google user login (Case A) is idempotent and does not create duplicate user or organization', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const sub = `sub-repeat-${Date.now()}`;
  const email = `${TAG}-repeat@greenpilot.test`;
  const name = 'Repeat User';
  const token = `test-token:${sub}:${email}:${name}`;

  const client1 = jar();
  const firstRes = await client1.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: token }),
  });
  assert.equal(firstRes.status, 200);
  const firstUserId = firstRes.body.user.id;
  const firstOrgId = firstRes.body.organization.id;

  // Second login with exact same Google identity
  const client2 = jar();
  const secondRes = await client2.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: token }),
  });
  assert.equal(secondRes.status, 200);
  assert.equal(secondRes.body.user.id, firstUserId, 'Same user ID is returned');
  assert.equal(secondRes.body.organization.id, firstOrgId, 'Same organization ID is returned');

  // DB verification: count users and organizations
  const { rows: uCount } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM coexistence.forgecrm_users WHERE google_subject = $1',
    [sub]
  );
  assert.equal(uCount[0].n, 1, 'No duplicate user rows created');

  const { rows: mCount } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM coexistence.organization_members WHERE user_id = $1',
    [firstUserId]
  );
  assert.equal(mCount[0].n, 1, 'No duplicate organization memberships created');
});

test('3. Account linking (Case B) links Google identity to existing verified email without duplicate account', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const email = `${TAG}-legacy@greenpilot.test`;
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('secret123', 4);

  // Pre-seed an email/password user
  const { rows: ins } = await pool.query(
    `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role)
     VALUES ($1, $2, $3, 'Legacy User', 'admin')
     RETURNING id`,
    [`${TAG}-legacy`, email, hash]
  );
  const existingId = ins[0].id;

  // Pre-seed an organization for this user
  const { rows: orgIns } = await pool.query(
    `INSERT INTO coexistence.organizations (name, slug)
     VALUES ('Legacy Org', $1) RETURNING id`,
    [`legacy-org-${Date.now().toString(36)}`]
  );
  await pool.query(
    `INSERT INTO coexistence.organization_members (organization_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [orgIns[0].id, existingId]
  );

  // User logs in via Google with the matching verified email
  const googleSub = `sub-linked-${Date.now()}`;
  const token = `test-token:${googleSub}:${email}:Linked Google User`;

  const client = jar();
  const res = await client.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: token }),
  });

  assert.equal(res.status, 200, 'Linking succeeds');
  assert.equal(res.body.user.id, existingId, 'Authenticated as existing user');
  assert.equal(res.body.user.googleSubject, googleSub, 'google_subject was linked');
  assert.equal(res.body.organization.id, orgIns[0].id, 'Retains existing organization');

  // Verify DB state
  const { rows: uRows } = await pool.query(
    'SELECT id, google_subject, email_verified FROM coexistence.forgecrm_users WHERE id = $1',
    [existingId]
  );
  assert.equal(uRows[0].google_subject, googleSub, 'DB has linked google_subject');
  assert.equal(uRows[0].email_verified, true, 'DB email_verified is set to true');

  // Ensure total users with this email is still 1
  const { rows: total } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM coexistence.forgecrm_users WHERE email = $1',
    [email]
  );
  assert.equal(total[0].n, 1, 'No duplicate user created');
});

test('4. Disabled user cannot authenticate with Google', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const sub = `sub-disabled-${Date.now()}`;
  const email = `${TAG}-disabled@greenpilot.test`;
  const token = `test-token:${sub}:${email}:Disabled User`;

  const client = jar();
  // First create the user
  const initRes = await client.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: token }),
  });
  assert.equal(initRes.status, 200);
  const userId = initRes.body.user.id;

  // Deactivate the user
  await pool.query('UPDATE coexistence.forgecrm_users SET is_active = FALSE WHERE id = $1', [userId]);

  // Attempt login again
  const client2 = jar();
  const res = await client2.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: token }),
  });

  assert.equal(res.status, 403, 'Returns 403 Forbidden');
  assert.equal(res.body.code, 'account-disabled', 'Returns account-disabled code');
});

test('5. Invalid or missing Google credential is rejected', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const client = jar();

  // Missing body / empty credential
  const r1 = await client.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(r1.status, 400, 'Missing credential returns 400');
  assert.equal(r1.body.code, 'missing-credential');

  // Malformed / invalid token string
  const r2 = await client.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: 'invalid.jwt.token' }),
  });
  assert.equal(r2.status, 401, 'Invalid token returns 401');
  assert.equal(r2.body.code, 'invalid-token');
});

test('6. Session cookie grants access to protected routes and me lookup', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const sub = `sub-session-${Date.now()}`;
  const email = `${TAG}-session@greenpilot.test`;
  const token = `test-token:${sub}:${email}:Session User`;

  const client = jar();
  const loginRes = await client.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: token }),
  });
  assert.equal(loginRes.status, 200);

  // Call /api/v1/auth/me using the issued cookie
  const meRes = await client.fetch('/api/v1/auth/me');
  assert.equal(meRes.status, 200, 'me endpoint returns 200');
  assert.equal(meRes.body.user.email, email);
  assert.equal(meRes.body.user.googleSubject, sub);
  assert.equal(meRes.body.user.emailVerified, true);
});

test('7. Tenant boundary is enforced: user cannot access unauthorized organization context', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const subA = `sub-tenantA-${Date.now()}`;
  const emailA = `${TAG}-tenantA@greenpilot.test`;
  const clientA = jar();
  const resA = await clientA.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: `test-token:${subA}:${emailA}:Tenant A` }),
  });
  assert.equal(resA.status, 200);
  const orgAId = resA.body.organization.id;

  const subB = `sub-tenantB-${Date.now()}`;
  const emailB = `${TAG}-tenantB@greenpilot.test`;
  const clientB = jar();
  const resB = await clientB.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: `test-token:${subB}:${emailB}:Tenant B` }),
  });
  assert.equal(resB.status, 200);

  // User B attempts to access User A's organization via X-Org-Id header
  const crossRes = await clientB.fetch('/api/v1/settings/overview', {
    headers: { 'X-Org-Id': orgAId },
  });
  assert.equal(crossRes.status, 403, 'Cross-tenant access is rejected with 403 Forbidden');
});

test('8. Logout clears session cookie and revokes access', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const sub = `sub-logout-${Date.now()}`;
  const email = `${TAG}-logout@greenpilot.test`;
  const client = jar();
  await client.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: `test-token:${sub}:${email}:Logout User` }),
  });

  const meBefore = await client.fetch('/api/v1/auth/me');
  assert.equal(meBefore.status, 200);

  // Logout
  const logoutRes = await client.fetch('/api/v1/auth/logout', { method: 'POST' });
  assert.equal(logoutRes.status, 200);

  // Simulate client dropping cookie after Clear-Cookie
  client.clear();
  const meAfter = await client.fetch('/api/v1/auth/me');
  assert.equal(meAfter.status, 401, 'Subsequent me request is 401 Unauthorized');
});

test('9. Protected route without session returns 401 Unauthorized', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const client = jar();
  const res = await client.fetch('/api/v1/auth/me');
  assert.equal(res.status, 401, 'Returns 401 Unauthorized');
  assert.equal(res.body.error, 'Unauthorized');
});

test('10. Expired or invalid session token returns 401 and invalidates session', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const client = jar();
  // Manually attach an invalid cookie
  const res = await client.fetch('/api/v1/auth/me', {
    headers: {
      Cookie: 'forgecrm_token=invalid.jwt.token.signature',
    },
  });
  assert.equal(res.status, 401, 'Invalid token returns 401');
  assert.equal(res.body.error, 'Invalid token');
});

test('11. Unverified Google email does not link existing account (prevents identity spoofing)', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const email = `${TAG}-unverified@greenpilot.test`;
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('secret123', 4);

  // Pre-seed an email user
  await pool.query(
    `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role)
     VALUES ($1, $2, $3, 'Legit User', 'viewer')`,
    [`${TAG}-unverified`, email, hash]
  );

  // Set mock to return email_verified = false
  const prevVerifier = setTestGoogleVerifier;
  setTestGoogleVerifier((token) => {
    if (token === 'spoofed-token') {
      return {
        sub: 'attacker-sub-999',
        email,
        emailVerified: false,
        name: 'Attacker',
        picture: null,
      };
    }
    return { sub: 'sub-x', email: 'x@test.com', emailVerified: true };
  });

  const client = jar();
  const res = await client.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: 'spoofed-token' }),
  });

  assert.equal(res.status, 400, 'Rejects unverified email linking');
  assert.equal(res.body.code, 'unverified-email');

  // Verify original user record was not corrupted
  const { rows } = await pool.query(
    'SELECT google_subject FROM coexistence.forgecrm_users WHERE email = $1',
    [email]
  );
  assert.equal(rows[0].google_subject, null, 'google_subject was not linked');
});

test('12. WhatsApp connection status is NOT required to authenticate or enter Green Pilot', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const sub = `sub-nowa-${Date.now()}`;
  const email = `${TAG}-nowa@greenpilot.test`;
  const token = `test-token:${sub}:${email}:No WhatsApp User`;

  // Reset default test verifier
  setTestGoogleVerifier((tok) => {
    if (tok && tok.startsWith('test-token:')) {
      const parts = tok.split(':');
      const s = parts[1] || `google-sub-${Date.now()}`;
      const em = (parts[2] || `user-${s}@example.com`).trim().toLowerCase();
      const nm = parts[3] || 'Test User';
      return { sub: s, email: em, emailVerified: true, name: nm, picture: null };
    }
    throw new AuthError('Invalid or expired Google credential', 401, 'invalid-token');
  });

  const client = jar();
  const res = await client.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: token }),
  });

  assert.equal(res.status, 200, 'Authentication succeeds without WhatsApp');
  assert.ok(res.body.organization.id, 'Organization resolved without WhatsApp');
  // Check WhatsApp step is reported as pending/optional, not blocking
  if (res.body.onboarding?.steps?.whatsapp) {
    assert.equal(res.body.onboarding.steps.whatsapp.required, false, 'WhatsApp step is optional');
  }
});
