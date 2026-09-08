// Green Pilot organization tenancy service.
//
// Ownership chain: every tenant-owned row hangs off organizations(id), and every
// request's org context derives from organization_members — never from a
// client-supplied id alone. All functions take an explicit `db` (pool or client)
// so unit tests can inject a stub.
//
// Legacy rule: rows with organization_id NULL belong to the pre-tenancy
// single-owner scope. They are visible only through dual-read paths until the
// approval-gated backfill assigns them (see PHASE5_DATABASE_EVOLUTION_PLAN.md).

// Express-style error carrying an HTTP status (+ optional machine code) so
// tenant denials map to 403/400 at the route layer without re-interpretation.
class HttpError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string} [code]
   */
  constructor(message, status, code) {
    super(message);
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const stem = base.replace(/^-+/, '') || 'org';
  return `${stem}-${Date.now().toString(36)}`;
}

// All orgs a user belongs to, with their membership role.
/**
 * @param {{query: Function}} db
 * @param {number|string} userId
 */
async function listUserOrganizations(db, userId) {
  const { rows } = await db.query(
    `SELECT o.id, o.name, o.slug, o.plan,
            o.ai_credits_granted, o.ai_credits_used,
            m.role AS membership_role, m.created_at AS joined_at
       FROM coexistence.organization_members m
       JOIN coexistence.organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1
      ORDER BY m.created_at ASC`,
    [userId]
  );
  return rows;
}

// Membership row for (user, org), or null. This is the ONLY proof of access.
/**
 * @param {{query: Function}} db
 * @param {number|string} userId
 * @param {string} organizationId
 */
async function assertMembership(db, userId, organizationId) {
  if (!userId || !organizationId) return null;
  const { rows } = await db.query(
    `SELECT m.organization_id, m.role,
            o.id AS id, o.name, o.slug, o.plan,
            o.ai_credits_granted, o.ai_credits_used
       FROM coexistence.organization_members m
       JOIN coexistence.organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 AND m.organization_id = $2`,
    [userId, organizationId]
  );
  return rows[0] || null;
}

// Create an org + make the creator its owner, atomically. Returns the org row.
/**
 * @param {{query: Function, connect?: Function}} db
 * @param {number|string} userId
 * @param {{name?: string, slug?: string}} [opts]
 */
async function createOrganization(db, userId, { name, slug } = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) {
    throw new HttpError('Organization name is required', 400);
  }
  const finalSlug = String(slug || '').trim() || slugify(cleanName);
  const client = db.connect ? await db.connect() : db;
  const release = db.connect ? () => client.release() : () => {};
  try {
    if (db.connect) await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO coexistence.organizations (name, slug)
       VALUES ($1, $2) RETURNING *`,
      [cleanName, finalSlug]
    );
    await client.query(
      `INSERT INTO coexistence.organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [rows[0].id, userId]
    );
    if (db.connect) await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    if (db.connect) {
      try { await client.query('ROLLBACK'); } catch { /* already failed */ }
    }
    throw err;
  } finally {
    release();
  }
}

// Webhook tenant rule (shared by the v1 webhook route + tests):
// allow when the account is legacy-unassigned (null org, dual-read) or owned
// by the expected org; deny everything else — including unknown accounts.
function isOrgWebhookAllowed(accountOrgId, expectedOrgId) {
  if (accountOrgId === undefined) return false; // unknown account
  if (accountOrgId === null) return true; // legacy unassigned (dual-read)
  return String(accountOrgId) === String(expectedOrgId);
}
// - requestedOrgId is HONORED ONLY with membership (else 403 not-member).
// - without a request, single-org users get implicit context; multi-org users
//   must choose (400 ambiguous) — never silently pick across tenants.
// - users with no orgs get 403 no-organization (fail closed).
/**
 * @param {Array<Record<string, unknown>>} memberships
 * @param {string} [requestedOrgId]
 */
function resolveTenantContext(memberships, requestedOrgId) {
  const list = Array.isArray(memberships) ? memberships : [];
  if (list.length === 0) {
    throw new HttpError('No organization membership — access denied', 403, 'no-organization');
  }
  if (requestedOrgId) {
    const hit = list.find(m =>
      String(m.organization_id || m.id) === String(requestedOrgId) ||
      String(m.slug) === String(requestedOrgId)
    );
    if (!hit) {
      throw new HttpError('Not a member of the requested organization', 403, 'not-member');
    }
    return hit;
  }
  if (list.length === 1) return list[0];
  throw new HttpError('Multiple organizations — specify X-Org-Id', 400, 'ambiguous-organization');
}

module.exports = {
  HttpError,
  slugify,
  listUserOrganizations,
  assertMembership,
  createOrganization,
  resolveTenantContext,
  isOrgWebhookAllowed,
};
