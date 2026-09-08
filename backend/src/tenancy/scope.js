// Green Pilot tenant-scoped data access (Step 11).
//
// Rule: repositories take (organizationId, id) — never a bare id. Helpers here
// keep every service consistent: resolve the caller's org once, then stamp or
// filter with it. NULL org rows are legacy scope: visible only to callers
// WITHOUT an org context (pre-backfill installs) or via explicit dual-read.

// Caller org from request (API) or webhook context. Null = legacy scope.
function orgIdFrom(req) {
  return (req && (req.org?.id || req.webhookOrgId)) || null;
}

function requireOrgId(req) {
  const id = orgIdFrom(req);
  if (!id) {
    const { HttpError } = require('./organizations');
    throw new HttpError('Organization context required', 403, 'no-organization');
  }
  return id;
}

// Fetch one row by id strictly inside the org. Legacy NULL-org rows are
// returned ONLY to legacy (null-org) callers — an org caller never sees them,
// and a legacy caller never sees org-owned rows. Returns row or null (→ 404,
// never 403, so tenants cannot probe each other's ids).
async function assertOrgRow(db, table, idColumn, id, orgId, columns = '*') {
  const { rows } = await db.query(
    `SELECT ${columns} FROM coexistence.${table}
      WHERE ${idColumn} = $1
        AND (($2::uuid IS NULL AND organization_id IS NULL)
          OR ($2::uuid IS NOT NULL AND organization_id = $2))`,
    [id, orgId]
  );
  return rows[0] || null;
}

// Tenant WHERE fragment for list queries: appends
// `AND <alias>.organization_id = $n` (org caller) or
// `AND <alias>.organization_id IS NULL` (legacy caller).
function orgFilterClause(alias, orgId, nextParam) {
  if (orgId) return { clause: `AND ${alias}.organization_id = $${nextParam}`, params: [orgId] };
  return { clause: `AND ${alias}.organization_id IS NULL`, params: [] };
}

// Worker-path guard (Steps 9–10): a job stamped for org A must never execute
// against org B's configuration/credentials. Dual-read: unstamped jobs and
// unassigned accounts pass (legacy transition); explicit mismatch is denied.
function tenantJobAllowed(jobOrgId, accountOrgId) {
  if (!jobOrgId || !accountOrgId) return true;
  return String(jobOrgId) === String(accountOrgId);
}

module.exports = { orgIdFrom, requireOrgId, assertOrgRow, orgFilterClause, tenantJobAllowed };
