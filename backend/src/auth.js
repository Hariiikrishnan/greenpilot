const { Router } = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { effectivePages } = require('./permissions');
const { verifyGoogleIdToken, resolveGoogleIdentity, AuthError } = require('./googleAuth');

// Build the full session for a user: identity + role + the resolved page list
// + the WhatsApp numbers they're assigned to. The frontend uses `pages` to
// gate nav/routes and `role` to decide admin-only UI.
async function loadUserSession(userId) {
  const { rows } = await pool.query(
    `SELECT id, username, email, display_name, role, permissions, is_active, last_login_at,
            google_subject, avatar_url, email_verified
       FROM coexistence.forgecrm_users WHERE id = $1`,
    [userId]
  );
  const u = rows[0];
  if (!u) return null;
  const { rows: waRows } = await pool.query(
    `SELECT wa_number FROM coexistence.user_wa_assignments WHERE user_id = $1`,
    [userId]
  );
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    isActive: u.is_active,
    permissions: u.permissions || null,
    avatarUrl: u.avatar_url || null,
    googleSubject: u.google_subject || null,
    emailVerified: u.email_verified || false,
    pages: Array.from(effectivePages({ role: u.role, permissions: u.permissions })),
    assignedWaNumbers: waRows.map(r => r.wa_number),
  };
}

// JWT_SECRET is guaranteed present + strong by util/instanceSecrets, which runs
// first in index.js (resolves from env, else a persisted file, else generates
// one). The fallback below only matters for non-standard entry points.
const JWT_SECRET = process.env.JWT_SECRET || 'forgecrm-dev-secret-change-me';
const COOKIE_NAME = 'forgecrm_token';
const TOKEN_EXPIRY = '24h';

// Phase 13: cookie deletion must mirror creation attributes (path + secure +
// samesite), otherwise browsers keep the session cookie after logout.
function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000,
  };
}

function clearSessionCookie(res) {
  const { maxAge: _maxAge, ...clearOpts } = cookieOpts();
  res.clearCookie(COOKIE_NAME, clearOpts);
}

const router = Router();

// Ensure tables exist on startup
async function ensureTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS coexistence.forgecrm_users (
        id         BIGSERIAL PRIMARY KEY,
        username   TEXT NOT NULL UNIQUE,
        email      TEXT NOT NULL UNIQUE,
        password   TEXT NOT NULL,
        display_name TEXT,
        role       TEXT NOT NULL DEFAULT 'viewer',
        google_subject TEXT UNIQUE,
        avatar_url TEXT,
        email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE coexistence.forgecrm_users
        ADD COLUMN IF NOT EXISTS google_subject TEXT UNIQUE,
        ADD COLUMN IF NOT EXISTS avatar_url TEXT,
        ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // First admin: when the users table is empty, only seed non-interactively if
    // ADMIN_PASSWORD is provided (headless/CI installs). Otherwise leave the
    // table empty so the first-run UI setup wizard (GET /auth/status ->
    // setupRequired, POST /auth/setup) creates the admin in the browser. No
    // password is ever generated or written to disk.
    const { rows } = await client.query('SELECT COUNT(*) FROM coexistence.forgecrm_users');
    if (parseInt(rows[0].count, 10) === 0) {
      if (process.env.ADMIN_PASSWORD) {
        const adminEmail = (process.env.ADMIN_EMAIL || 'admin@greenpilot.io').trim().toLowerCase();
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
        await client.query(
          `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role)
           VALUES ('admin', $1, $2, 'Admin', 'admin')`,
          [adminEmail, hash]
        );
        console.log(`[auth] Seeded admin '${adminEmail}' from ADMIN_PASSWORD.`);
      } else {
        console.log('[auth] No users yet — the first-run setup wizard will create the admin account in the UI.');
      }
    }
  } finally {
    client.release();
  }
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, displayName: user.display_name, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

async function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  // Legacy tokens (issued by the single-user build) carry no role. Force a
  // clean re-login so every session has a role for permission checks.
  if (!payload.role) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
  try {
    // Re-check the live account on every request so a deactivated or demoted
    // user loses access immediately, instead of keeping their old privileges
    // until the 24h token expires. The fresh role also overrides any stale role
    // embedded in the JWT (an admin who demotes a user takes effect at once).
    const { rows } = await pool.query(
      'SELECT role, is_active FROM coexistence.forgecrm_users WHERE id = $1',
      [payload.id]
    );
    const u = rows[0];
    if (!u) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'User not found' });
    }
    if (u.is_active === false) {
      clearSessionCookie(res);
      return res.status(403).json({ error: 'Account disabled' });
    }
    req.user = { ...payload, role: u.role };
    next();
  } catch (err) {
    console.error('[auth] authMiddleware account check failed:', err.message);
    res.status(500).json({ error: 'Authentication check failed' });
  }
}

// POST /api/auth/register — public self-signup (SaaS onboarding entry).
// Creates user + personal organization + owner membership atomically.
// 409 when the email is taken. Rate-limiting is handled by the global
// apiLimiter; password floor is 8 chars like /auth/setup.
router.post('/auth/register', async (req, res) => {
  const { email, password, displayName, organizationName } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`register:${cleanEmail}`]);
    const { rows: taken } = await client.query(
      'SELECT id FROM coexistence.forgecrm_users WHERE email = $1', [cleanEmail]
    );
    if (taken.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists', code: 'email-taken' });
    }
    const username = cleanEmail.split('@')[0].slice(0, 60) || `user${Date.now().toString(36)}`;
    const hash = await bcrypt.hash(String(password), 10);
    // Phase 12 SaaS baseline: the signup user keeps the least-privilege app
    // role (viewer) but receives explicit page grants for daily team use +
    // workspace setup (see permissions.OWNER_PAGE_GRANTS). Instance-admin
    // surfaces stay ungated; every backend endpoint enforces its own gate.
    const { OWNER_PAGE_GRANTS } = require('./permissions');
    const { rows: users } = await client.query(
      `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role, permissions)
       VALUES ($1, $2, $3, $4, 'viewer', $5)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, username, display_name, role`,
      [username, cleanEmail, hash, String(displayName || username).trim().slice(0, 200), JSON.stringify({ grant: OWNER_PAGE_GRANTS })]
    );
    if (users.length === 0) {
      // Lost a race with a concurrent register — report as taken.
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists', code: 'email-taken' });
    }
    const userId = users[0].id;
    // Personal organization (retry-safe: unique slug; duplicates on retry get
    // distinct slugs — use Idempotency-Key on POST /v1/orgs instead when the
    // client needs exact once-only semantics after signup).
    const { createOrganization } = require('./tenancy/organizations');
    // Plain query facade (NO connect) so createOrganization joins THIS
    // transaction instead of opening a nested one.
    const txDb = { query: (t, p) => client.query(t, p) };
    const org = await createOrganization(txDb, userId, {
      name: String(organizationName || `${users[0].display_name || username}'s workspace`).trim().slice(0, 200),
    });
    await client.query('COMMIT');
    const token = signToken({ ...users[0], display_name: users[0].display_name });
    res.cookie(COOKIE_NAME, token, cookieOpts());
    const session = await loadUserSession(userId);
    res.status(201).json({ user: session, organization: { id: org.id, name: org.name, slug: org.slug } });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists', code: 'email-taken' });
    }
    console.error('[auth] register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// POST /api/auth/google (and /api/v1/auth/google) — Google Primary Authentication.
// Verifies Google ID token, links or creates user and organization idempotently,
// and sets the secure Green Pilot session cookie.
router.post('/auth/google', async (req, res) => {
  const { credential, token, organizationName } = req.body || {};
  const idToken = credential || token;
  if (!idToken || typeof idToken !== 'string') {
    return res.status(400).json({ error: 'Google credential is required', code: 'missing-credential' });
  }

  try {
    const googleUser = await verifyGoogleIdToken(idToken);
    const { user, organization, onboarding } = await resolveGoogleIdentity({
      googleUser,
      organizationName,
    });

    const sessionToken = signToken(user);
    res.cookie(COOKIE_NAME, sessionToken, cookieOpts());
    const session = await loadUserSession(user.id);
    res.json({
      user: session,
      organization,
      onboarding,
    });
  } catch (err) {
    if (err instanceof AuthError || err.status) {
      return res.status(err.status || 400).json({
        error: err.message,
        code: err.code || 'auth-failed',
      });
    }
    console.error('[auth:google] Authentication error:', err.message);
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

// POST /api/auth/login
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT * FROM coexistence.forgecrm_users WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      // Phase 13 observability: authentication failures are logged (email
      // only — never passwords) with the request id for abuse triage.
      console.warn(`[auth] login failed for '${String(email).trim().toLowerCase()}' (rid=${req.id || '-'})`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.is_active === false) {
      console.warn(`[auth] login blocked (disabled account) for '${String(email).trim().toLowerCase()}' (rid=${req.id || '-'})`);
      return res.status(403).json({ error: 'Account is disabled. Contact an administrator.' });
    }
    const token = signToken(user);
    res.cookie(COOKIE_NAME, token, cookieOpts());
    // Best-effort: stamp last_login_at; don't fail login if this errors.
    pool.query(`UPDATE coexistence.forgecrm_users SET last_login_at = NOW() WHERE id = $1`, [user.id]).catch(() => {});
    const session = await loadUserSession(user.id);
    res.json({ user: session });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const session = await loadUserSession(req.user.id);
    if (!session) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'User not found' });
    }
    if (session.isActive === false) {
      clearSessionCookie(res);
      return res.status(403).json({ error: 'Account disabled' });
    }
    res.json({ user: session });
  } catch (err) {
    console.error('[auth] me error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// POST /api/auth/logout
router.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/status — public. Tells the frontend whether to show the
// first-run setup wizard (no users yet) instead of the login screen.
router.get('/auth/status', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM coexistence.forgecrm_users');
    res.json({ setupRequired: rows[0].n === 0 });
  } catch (err) {
    // DB not ready / not migrated yet — let the UI retry.
    res.status(503).json({ error: 'Service starting' });
  }
});

// POST /api/auth/setup — public, ONE-TIME. Creates the first admin only while
// the users table is empty, then issues the auth cookie. Returns 409 once an
// account exists. A transaction-scoped advisory lock serializes concurrent
// setup attempts so exactly one admin is created.
router.post('/auth/setup', async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(947218531)');
    const { rows: cnt } = await client.query('SELECT COUNT(*)::int AS n FROM coexistence.forgecrm_users');
    if (cnt[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Setup already completed' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows: ins } = await client.query(
      `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role)
       VALUES ('admin', $1, $2, $3, 'admin')
       RETURNING id, username, display_name, role`,
      [email.trim().toLowerCase(), hash, (displayName || 'Admin').trim()]
    );
    await client.query('COMMIT');
    const token = signToken(ins[0]);
    res.cookie(COOKIE_NAME, token, cookieOpts());
    const session = await loadUserSession(ins[0].id);
    res.status(201).json({ user: session });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (err && err.code === '23505') {
      // Unique violation (email/username) — treat as already set up.
      return res.status(409).json({ error: 'Setup already completed' });
    }
    console.error('[auth] setup error:', err.message);
    res.status(500).json({ error: 'Setup failed' });
  } finally {
    client.release();
  }
});

module.exports = { router, authMiddleware, ensureTables, COOKIE_NAME };
