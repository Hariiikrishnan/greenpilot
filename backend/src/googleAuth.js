// Green Pilot — Phase 1: Google Identity Services backend verification & user/org resolution.
//
// Verifies Google ID tokens server-side, extracts the immutable `sub` identifier,
// and resolves/creates user + organization membership idempotently.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const pool = require('./db');
const { createOrganization } = require('./tenancy/organizations');
const { OWNER_PAGE_GRANTS } = require('./permissions');
const { computeOnboardingStatus } = require('./onboarding/service');

class AuthError extends Error {
  constructor(message, status = 400, code = 'auth-error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Configurable OAuth2 client instance
let oauthClient = null;
function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!oauthClient && clientId) {
    oauthClient = new OAuth2Client(clientId);
  }
  return oauthClient;
}

// Test / Mock hook for hermetic unit testing without live network calls
let testVerifier = null;
function setTestGoogleVerifier(fn) {
  testVerifier = fn;
}

/**
 * Verifies a Google ID token server-side and returns normalized claims.
 * @param {string} idToken - The JWT credential returned by Google Identity Services.
 * @returns {Promise<{sub: string, email: string, emailVerified: boolean, name: string|null, picture: string|null}>}
 */
async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string' || idToken.trim().length === 0) {
    throw new AuthError('Google ID token is required', 400, 'missing-token');
  }

  const cleanToken = idToken.trim();

  // Test mode hook (used by automated test suites)
  if (testVerifier) {
    return testVerifier(cleanToken);
  }

  // Support test tokens formatted as "test-token:<sub|email|name>" in test/dev (never in production)
  if (process.env.NODE_ENV !== 'production' && cleanToken.startsWith('test-token:')) {
    const parts = cleanToken.split(':');
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

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId && process.env.NODE_ENV === 'production') {
    console.error('[auth:google] GOOGLE_CLIENT_ID is not configured in production environment');
    throw new AuthError('Google authentication is temporarily unavailable', 503, 'misconfigured-auth');
  }

  try {
    const client = getOAuthClient() || new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({
      idToken: cleanToken,
      audience: clientId || undefined,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) {
      throw new AuthError('Invalid Google credential payload', 401, 'invalid-payload');
    }

    const sub = String(payload.sub).trim();
    const email = String(payload.email || '').trim().toLowerCase();
    const emailVerified = Boolean(payload.email_verified);
    const name = payload.name ? String(payload.name).trim() : null;
    const picture = payload.picture ? String(payload.picture).trim() : null;

    if (!email) {
      throw new AuthError('Google account must provide an email address', 400, 'missing-email');
    }

    return {
      sub,
      email,
      emailVerified,
      name,
      picture,
    };
  } catch (err) {
    // If google-auth-library failed, attempt fallback via Google tokeninfo endpoint
    if (err instanceof AuthError) throw err;

    try {
      const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(cleanToken)}`;
      const res = await fetch(url);
      if (res.ok) {
        const info = await res.json();
        if (info && info.sub) {
          if (clientId && info.aud !== clientId) {
            throw new AuthError('Google credential audience mismatch', 401, 'audience-mismatch');
          }
          return {
            sub: String(info.sub).trim(),
            email: String(info.email || '').trim().toLowerCase(),
            emailVerified: info.email_verified === 'true' || info.email_verified === true,
            name: info.name ? String(info.name).trim() : null,
            picture: info.picture ? String(info.picture).trim() : null,
          };
        }
      }
    } catch {
      // Ignore fallback error and rethrow main error
    }

    console.warn('[auth:google] Token verification failed:', err.message);
    throw new AuthError('Invalid or expired Google credential', 401, 'invalid-token');
  }
}

/**
 * Resolves a Google identity to a Green Pilot user and organization.
 * Handles Case A (existing Google user), Case B (existing email user), and Case C (new user).
 * Idempotent and thread-safe via PostgreSQL advisory locks.
 */
async function resolveGoogleIdentity({ googleUser, organizationName = null }) {
  const { sub, email, emailVerified, name, picture } = googleUser;
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!sub) {
    throw new AuthError('Google subject identifier is missing', 400, 'missing-sub');
  }
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new AuthError('A valid email address is required', 400, 'invalid-email');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Advisory lock keyed on email hash to serialize concurrent logins/signups
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`google-auth:${cleanEmail}`]);

    let resolvedUser = null;

    // CASE A: User with this exact google_subject exists
    const { rows: subMatches } = await client.query(
      `SELECT id, username, email, display_name, role, permissions, is_active, google_subject, avatar_url, email_verified
         FROM coexistence.forgecrm_users
        WHERE google_subject = $1`,
      [sub]
    );

    if (subMatches.length > 0) {
      resolvedUser = subMatches[0];
      if (resolvedUser.is_active === false) {
        await client.query('ROLLBACK');
        throw new AuthError('Account is disabled. Contact an administrator.', 403, 'account-disabled');
      }

      // Update last_login_at and freshen avatar or verified state if missing
      await client.query(
        `UPDATE coexistence.forgecrm_users
            SET last_login_at = NOW(),
                avatar_url = COALESCE(avatar_url, $1),
                email_verified = TRUE,
                updated_at = NOW()
          WHERE id = $2`,
        [picture, resolvedUser.id]
      );
    } else {
      // CASE B: Check if an existing account with the same email exists (e.g. registered via email/password)
      const { rows: emailMatches } = await client.query(
        `SELECT id, username, email, display_name, role, permissions, is_active, google_subject, avatar_url, email_verified
           FROM coexistence.forgecrm_users
          WHERE email = $1`,
        [cleanEmail]
      );

      if (emailMatches.length > 0) {
        resolvedUser = emailMatches[0];
        if (resolvedUser.is_active === false) {
          await client.query('ROLLBACK');
          throw new AuthError('Account is disabled. Contact an administrator.', 403, 'account-disabled');
        }

        // Account linking: link Google identity safely if email is verified by Google
        if (emailVerified) {
          await client.query(
            `UPDATE coexistence.forgecrm_users
                SET google_subject = $1,
                    email_verified = TRUE,
                    avatar_url = COALESCE(avatar_url, $2),
                    last_login_at = NOW(),
                    updated_at = NOW()
              WHERE id = $3`,
            [sub, picture, resolvedUser.id]
          );
          resolvedUser.google_subject = sub;
          resolvedUser.avatar_url = resolvedUser.avatar_url || picture;
          resolvedUser.email_verified = true;
        } else {
          // Unverified email from Google ID token — do not link without verification
          await client.query('ROLLBACK');
          throw new AuthError('Google account email must be verified to link existing account', 400, 'unverified-email');
        }
      } else {
        // CASE C: Brand new user creation
        const baseUsername = cleanEmail.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 50) || `user${Date.now().toString(36)}`;
        let finalUsername = baseUsername;

        // Ensure username is unique
        const { rows: userCheck } = await client.query(
          `SELECT id FROM coexistence.forgecrm_users WHERE username = $1`,
          [finalUsername]
        );
        if (userCheck.length > 0) {
          finalUsername = `${baseUsername}_${crypto.randomBytes(3).toString('hex')}`.slice(0, 60);
        }

        // Generate unguessable password hash to satisfy NOT NULL constraint safely
        const randomSecret = crypto.randomBytes(32).toString('hex');
        const hash = await bcrypt.hash(randomSecret, 10);
        const displayName = (name || baseUsername).trim().slice(0, 200);

        const { rows: newUsers } = await client.query(
          `INSERT INTO coexistence.forgecrm_users
             (username, email, password, display_name, role, permissions, is_active, google_subject, avatar_url, email_verified, last_login_at)
           VALUES
             ($1, $2, $3, $4, 'viewer', $5, TRUE, $6, $7, TRUE, NOW())
           RETURNING id, username, email, display_name, role, permissions, is_active, google_subject, avatar_url, email_verified`,
          [
            finalUsername,
            cleanEmail,
            hash,
            displayName,
            JSON.stringify({ grant: OWNER_PAGE_GRANTS }),
            sub,
            picture,
          ]
        );

        resolvedUser = newUsers[0];
      }
    }

    // Resolve or create Organization Membership
    const { rows: memberships } = await client.query(
      `SELECT o.id, o.name, o.slug, o.plan, m.role AS membership_role
         FROM coexistence.organization_members m
         JOIN coexistence.organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1
        ORDER BY m.created_at ASC`,
      [resolvedUser.id]
    );

    let activeOrg = null;
    let isFreshOrg = false;

    if (memberships.length > 0) {
      activeOrg = {
        id: memberships[0].id,
        name: memberships[0].name,
        slug: memberships[0].slug,
        plan: memberships[0].plan,
        membershipRole: memberships[0].membership_role,
      };
    } else {
      // User has no organization (fresh signup) — create personal organization
      const txDb = { query: (t, p) => client.query(t, p) };
      const defaultOrgName = String(
        organizationName || `${resolvedUser.display_name || resolvedUser.username}'s workspace`
      ).trim().slice(0, 200);

      const newOrg = await createOrganization(txDb, resolvedUser.id, {
        name: defaultOrgName,
      });

      activeOrg = {
        id: newOrg.id,
        name: newOrg.name,
        slug: newOrg.slug,
        plan: newOrg.plan,
        membershipRole: 'owner',
      };
      isFreshOrg = true;
    }

    await client.query('COMMIT');

    // Compute derived onboarding status for the organization
    let onboarding = { completed: false };
    if (activeOrg && activeOrg.id) {
      try {
        const status = await computeOnboardingStatus(pool, activeOrg.id);
        onboarding = {
          completed: Boolean(status.completed),
          requiredComplete: Boolean(status.requiredComplete),
          crmReady: Boolean(status.crmReady),
          steps: status.steps,
        };
      } catch (err) {
        console.warn('[auth:google] Failed to compute onboarding status:', err.message);
        onboarding = { completed: !isFreshOrg };
      }
    }

    return {
      user: resolvedUser,
      organization: activeOrg,
      onboarding,
      isNewUser: !subMatches.length && !resolvedUser.last_login_at,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  AuthError,
  verifyGoogleIdToken,
  resolveGoogleIdentity,
  setTestGoogleVerifier,
};
