// Centralised role → page-access map.
//
// Two roles ship today:
//   - admin     : full access (every page + Settings tabs, user management).
//   - bda_sales : "Sales" user — sees only their assigned chats/contacts.
// 'viewer' is kept as a legacy fallback.
//
// Page keys are stable strings used in three places:
//   - this map
//   - the frontend Sidebar / page guard
//   - server-side requirePermission(page) middleware
//
// "admin-settings:<tab>" entries gate individual tabs within Admin Settings.

const PAGES = [
  'home', 'chats', 'contacts', 'pipelines', 'bulk-message', 'template-builder',
  'chatbot-builder', 'media-library', 'about',
  'admin-settings:general', 'admin-settings:tags', 'admin-settings:category',
  'admin-settings:fields', 'admin-settings:whatsapp-accounts', 'admin-settings:users',
  'admin-settings:billing', 'admin-settings:mcp',
];

const ROLE_PAGE_DEFAULTS = {
  admin: PAGES.slice(),           // everything
  bda_sales: [
    'home', 'chats', 'contacts', 'pipelines', 'about',
    'admin-settings:general',     // only the General tab in user settings
  ],
  viewer: ['home', 'about'],      // legacy fallback
};

// Returns the set of pages a user can access given their role plus any
// per-user grant/revoke overrides stored in users.permissions JSONB.
//   permissions = { grant: ["template-builder"], revoke: ["admin-settings:general"] }
function effectivePages(user) {
  const base = ROLE_PAGE_DEFAULTS[user?.role] || [];
  const overrides = user?.permissions || {};
  const grant = Array.isArray(overrides.grant) ? overrides.grant : [];
  const revoke = new Set(Array.isArray(overrides.revoke) ? overrides.revoke : []);
  const out = new Set(base);
  grant.forEach(p => out.add(p));
  revoke.forEach(p => out.delete(p));
  return out;
}

function hasPermission(user, page) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return effectivePages(user).has(page);
}

function isAdmin(user) {
  return user?.role === 'admin';
}

// Phase 12 SaaS page grants — additive `permissions.grant` entries handed out
// by existing flows (self-signup, org creation, invitation accept) so a new
// customer can USE the product without an instance admin. Uses the existing
// per-user grant mechanism above — no new role system. Backend endpoints keep
// enforcing their own gates; these grants only affect frontend navigation and
// requirePermission(page) reads.
const BASELINE_TEAM_PAGES = ['home', 'chats', 'contacts', 'pipelines', 'about'];
const ORG_SETUP_TABS = [
  'admin-settings:general',
  'admin-settings:organization',
  'admin-settings:team',
  'admin-settings:profile',
  'admin-settings:whatsapp-accounts',
  'admin-settings:billing',
];
// Org owners/managers: daily team pages + workspace setup tabs + feature builders.
// Never the instance-admin surfaces (admin-settings:users, :mcp, :integrations).
const OWNER_FEATURE_PAGES = ['chatbot-builder', 'template-builder', 'media-library'];
const OWNER_PAGE_GRANTS = [...BASELINE_TEAM_PAGES, ...ORG_SETUP_TABS, ...OWNER_FEATURE_PAGES];
// Invited members: daily team pages + read-only general settings.
const MEMBER_PAGE_GRANTS = [...BASELINE_TEAM_PAGES, 'admin-settings:general'];

// Pure merge: union existing grants with additions (never removes, dedupes).
function mergePageGrants(existingPermissions, additions) {
  const base = (existingPermissions && typeof existingPermissions === 'object' && !Array.isArray(existingPermissions))
    ? existingPermissions
    : {};
  const cur = Array.isArray(base.grant) ? base.grant : [];
  const seen = new Set(cur.filter(p => typeof p === 'string'));
  for (const p of additions || []) {
    if (typeof p === 'string' && p) seen.add(p);
  }
  return { ...base, grant: [...seen] };
}

module.exports = {
  PAGES,
  ROLE_PAGE_DEFAULTS,
  effectivePages,
  hasPermission,
  isAdmin,
  BASELINE_TEAM_PAGES,
  ORG_SETUP_TABS,
  OWNER_PAGE_GRANTS,
  MEMBER_PAGE_GRANTS,
  mergePageGrants,
};
