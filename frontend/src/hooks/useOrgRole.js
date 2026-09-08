// Active-organization membership role for the signed-in user (Phase 12).
//
// Reads GET /v1/settings/organization (server-derived from membership — the
// client X-Org-Id hint is honored only with a membership row). Used for
// NAVIGATION gating only (which tabs/pages to show); every backend endpoint
// enforces its own authorization. Cached per active org id; returns null
// while unknown or when the user has no org context.

import { useState, useEffect } from 'react';
import { api, getActiveOrgId } from '../api.js';

const cache = new Map(); // orgId -> { role, isManager } | null

export function isManagerRole(role) {
  return role === 'owner' || role === 'admin';
}

export function useOrgRole() {
  const [info, setInfo] = useState(() => {
    const id = safeActiveOrg();
    return (id && cache.has(id)) ? cache.get(id) : null;
  });

  useEffect(() => {
    const id = safeActiveOrg();
    if (!id) { setInfo(null); return; }
    if (cache.has(id)) { setInfo(cache.get(id)); return; }
    let cancelled = false;
    api.settings.getOrganization()
      .then(o => {
        if (cancelled) return;
        const value = o ? { role: o.role || 'member', isManager: isManagerRole(o.role) } : null;
        cache.set(id, value);
        setInfo(value);
      })
      .catch(() => {
        if (cancelled) return;
        cache.set(id, null);
        setInfo(null);
      });
    return () => { cancelled = true; };
  }, []);

  return info; // { role, isManager } | null (null = unknown or no org)
}

function safeActiveOrg() {
  try { return getActiveOrgId(); } catch { return null; }
}

// Test-only: clear the module cache between tests.
export function __resetOrgRoleForTests() {
  cache.clear();
}

// Session teardown: drop cached org roles on logout so the next session on a
// shared device never inherits the previous user's manager affordances.
export function clearOrgRoleCache() {
  cache.clear();
}
