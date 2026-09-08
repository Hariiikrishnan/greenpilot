// Green Pilot tenant middleware.
//
// Chain: authMiddleware (who) → resolveTenant (which org may they act in).
// Sets req.org = { id, name, slug, plan, role } or leaves it null when the user
// has no orgs yet (legacy single-owner installs). Tenant-sensitive routes opt
// into enforcement with requireOrg (403 when no context).
//
// The client may SUGGEST an org via X-Org-Id header or ?orgId query, but the
// suggestion is honored only with a membership row — a forged id yields 403.

const pool = require('../db');
const { listUserOrganizations, resolveTenantContext } = require('../tenancy/organizations');

function orgFromMembership(m) {
  if (!m) return null;
  return {
    id: m.organization_id || m.id,
    name: m.name,
    slug: m.slug,
    plan: m.plan,
    role: m.membership_role || m.role || 'member',
  };
}

async function resolveTenant(req, _res, next) {
  try {
    if (!req.user?.id) return next(); // unauthenticated — authMiddleware decides
    const memberships = await listUserOrganizations(pool, req.user.id);
    if (memberships.length === 0) return next(); // legacy install, no orgs yet
    const requested = req.get('x-org-id') || req.query.orgId;
    try {
      req.org = orgFromMembership(resolveTenantContext(memberships, requested));
    } catch (err) {
      // Multi-org user without a selection: leave req.org null so requireOrg
      // routes fail closed with a clear error instead of guessing a tenant.
      if (err.code === 'ambiguous-organization' && !requested) return next();
      throw err;
    }
    return next();
  } catch (err) {
    // Pre-tenancy databases (migrations not yet applied): proceed without org
    // context instead of 500ing every authenticated request. The boot runner
    // applies 059 on start, so this path is transient by design.
    if (err && err.code === '42P01') return next();
    return next(err);
  }
}

// Fail closed: tenant-sensitive handlers mount this after resolveTenant.
function requireOrg(req, res, next) {
  if (!req.org?.id) {
    return res.status(403).json({
      error: 'Organization context required',
      code: req.user ? 'no-organization' : 'unauthorized',
    });
  }
  return next();
}

module.exports = { resolveTenant, requireOrg, orgFromMembership };
