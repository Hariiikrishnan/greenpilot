// Phase 12 organization + profile settings API (canonical: /api/v1/settings/*).
//
// Ownership chain (every mutation):
//   authenticated user → organization membership (requireOrg) → role check
//   → organization-scoped query → database.
// The client NEVER selects the organization: req.org.id (derived from
// membership) is the only org context. Cross-org reads return 404 semantics
// via requireOrg (no org context → 403).
//
// Routes:
//   GET    /settings/organization   — org profile (any member may read)
//   PUT    /settings/organization   — owner/admin only
//   GET    /settings/onboarding     — onboarding state + derived step status
//   PATCH  /settings/onboarding     — record seen/dismissed hints (any member)
//   POST   /settings/onboarding/complete — owner/admin, only when required
//                                        setup is actually complete
//   GET    /settings/profile        — own user profile
//   PUT    /settings/profile        — own display name (email change: no)
//   POST   /settings/password       — own password change
//   GET    /settings/whatsapp-status — real backend WhatsApp config status
//   GET    /settings/overview       — single onboarding hub payload
//                                      (org + onboarding + whatsapp + ai
//                                      entitlement + automation + crm counts)

const { Router } = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireOrg } = require('../middleware/tenant');
const {
  applyStepUpdate,
  computeOnboardingStatus,
  saveOnboardingState,
  loadOnboardingState,
} = require('../onboarding/service');

const router = Router();

function isManager(role) {
  return role === 'owner' || role === 'admin';
}

function orgShape(r) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    plan: r.plan,
    timezone: r.timezone || 'UTC',
    locale: r.locale || 'en',
    businessName: r.business_name || null,
    onboardingCompletedAt: r.onboarding_completed_at || null,
    role: undefined, // filled from req.org by callers that need it
  };
}

// --- Organization ------------------------------------------------------------

// GET /settings/organization — any member may read their own org's settings.
router.get('/settings/organization', requireOrg, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, plan, timezone, locale, business_name, onboarding_completed_at
         FROM coexistence.organizations WHERE id = $1`,
      [req.org.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Organization not found' });
    res.json({ ...orgShape(rows[0]), role: req.org.role });
  } catch (err) {
    console.error('[settings] org get error:', err.message);
    res.status(500).json({ error: 'Failed to load organization settings' });
  }
});

// PUT /settings/organization — owner/admin only. Validates timezone/locale.
router.put('/settings/organization', requireOrg, async (req, res) => {
  try {
    if (!isManager(req.org.role)) {
      return res.status(403).json({ error: 'Only owners and admins can edit organization settings' });
    }
    const { name, timezone, locale, businessName } = req.body || {};
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;
    const push = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };
    if (name !== undefined) {
      const clean = String(name || '').trim().slice(0, 200);
      if (!clean) return res.status(400).json({ error: 'Organization name cannot be empty' });
      push('name', clean);
    }
    if (timezone !== undefined) {
      const tz = String(timezone || '').trim().slice(0, 64) || 'UTC';
      // Validate against a conservative pattern (IANA-ish `Area/City` or UTC).
      if (!/^[A-Za-z0-9_+\-]+\/[A-Za-z0-9_+\-]+$/.test(tz) && tz !== 'UTC') {
        return res.status(422).json({ error: 'Invalid timezone (expected IANA like Asia/Kolkata, or UTC)' });
      }
      push('timezone', tz);
    }
    if (locale !== undefined) {
      const loc = String(locale || '').trim().slice(0, 12) || 'en';
      if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(loc)) {
        return res.status(422).json({ error: 'Invalid locale (expected like "en" or "en-IN")' });
      }
      push('locale', loc);
    }
    if (businessName !== undefined) {
      push('business_name', businessName ? String(businessName).trim().slice(0, 200) : null);
    }
    if (sets.length === 1) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.org.id);
    const { rows } = await pool.query(
      `UPDATE coexistence.organizations SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, name, slug, plan, timezone, locale, business_name, onboarding_completed_at`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Organization not found' });
    res.json({ ...orgShape(rows[0]), role: req.org.role });
  } catch (err) {
    console.error('[settings] org update error:', err.message);
    res.status(500).json({ error: 'Failed to update organization settings' });
  }
});

// --- Onboarding --------------------------------------------------------------

// GET /settings/onboarding — stored hints + derived real status.
router.get('/settings/onboarding', requireOrg, async (req, res) => {
  try {
    const { state, completedAt } = await loadOnboardingState(pool, req.org.id);
    const derived = await computeOnboardingStatus(pool, req.org.id);
    res.json({ stored: state, completedAt, derived, completed: derived.completed });
  } catch (err) {
    console.error('[settings] onboarding get error:', err.message);
    res.status(500).json({ error: 'Failed to load onboarding state' });
  }
});

// PATCH /settings/onboarding — record UI hints (seen/dismissed) per step.
// Never marks completion: `completed` is always recomputed server-side.
router.patch('/settings/onboarding', requireOrg, async (req, res) => {
  try {
    const { step, seen, dismissed } = req.body || {};
    if (!step) return res.status(400).json({ error: 'step is required' });
    const { state } = await loadOnboardingState(pool, req.org.id);
    const next = applyStepUpdate(state, step, { seen, dismissed });
    await saveOnboardingState(pool, req.org.id, next);
    const derived = await computeOnboardingStatus(pool, req.org.id);
    res.json({ stored: next, derived, completed: derived.completed });
  } catch (err) {
    console.error('[settings] onboarding patch error:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Failed to update onboarding state' });
  }
});

// POST /settings/onboarding/complete — owner/admin, only when required setup
// is ACTUALLY complete (org + CRM defaults). Never on bare click-through.
router.post('/settings/onboarding/complete', requireOrg, async (req, res) => {
  try {
    if (!isManager(req.org.role)) {
      return res.status(403).json({ error: 'Only owners and admins can complete onboarding' });
    }
    const derived = await computeOnboardingStatus(pool, req.org.id);
    if (!derived.completed) {
      return res.status(409).json({
        error: 'Required setup is not complete yet',
        code: 'onboarding-incomplete',
        derived,
      });
    }
    await pool.query(
      `UPDATE coexistence.organizations
          SET onboarding_state = COALESCE(onboarding_state, '{}'::jsonb),
              onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()),
              updated_at = NOW()
        WHERE id = $1`,
      [req.org.id]
    );
    const { state, completedAt } = await loadOnboardingState(pool, req.org.id);
    res.json({ stored: state, completedAt, derived, completed: true });
  } catch (err) {
    console.error('[settings] onboarding complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete onboarding' });
  }
});

// --- Profile (user-owned, NOT org-owned) -------------------------------------

// GET /settings/profile — own identity + account status.
router.get('/settings/profile', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, email, display_name, role, is_active, last_login_at, created_at
         FROM coexistence.forgecrm_users WHERE id = $1`,
      [req.user.id]
    );
    const u = rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: u.id,
      username: u.username,
      email: u.email,
      displayName: u.display_name,
      role: u.role,
      isActive: u.is_active,
      lastLoginAt: u.last_login_at,
      createdAt: u.created_at,
    });
  } catch (err) {
    console.error('[settings] profile get error:', err.message);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// PUT /settings/profile — own display name only. Email/role are admin-managed.
router.put('/settings/profile', async (req, res) => {
  try {
    const { displayName } = req.body || {};
    if (displayName === undefined) return res.status(400).json({ error: 'displayName is required' });
    const clean = String(displayName || '').trim().slice(0, 200);
    if (!clean) return res.status(400).json({ error: 'Display name cannot be empty' });
    const { rows } = await pool.query(
      `UPDATE coexistence.forgecrm_users SET display_name = $1, updated_at = NOW()
        WHERE id = $2 RETURNING id, username, email, display_name, role`,
      [clean, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ id: rows[0].id, username: rows[0].username, email: rows[0].email, displayName: rows[0].display_name, role: rows[0].role });
  } catch (err) {
    console.error('[settings] profile update error:', err.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /settings/password — own password change (verifies current password).
router.post('/settings/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (String(newPassword).length < 8) {
      return res.status(422).json({ error: 'New password must be at least 8 characters' });
    }
    const { rows } = await pool.query(
      `SELECT password FROM coexistence.forgecrm_users WHERE id = $1`, [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(String(currentPassword), rows[0].password);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(String(newPassword), 10);
    await pool.query(
      `UPDATE coexistence.forgecrm_users SET password = $1, updated_at = NOW() WHERE id = $2`,
      [hash, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[settings] password error:', err.message);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// --- WhatsApp status (real backend state) ------------------------------------
// Derives one of: not-configured | incomplete | verification-pending |
// connected | error. Never "connected" from a mere frontend attempt.
router.get('/settings/whatsapp-status', requireOrg, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, display_name, display_phone_number, is_active, is_default,
              health_status, last_error_message, last_error_at, last_success_at
         FROM coexistence.whatsapp_accounts WHERE organization_id = $1
         ORDER BY is_default DESC, created_at ASC`,
      [req.org.id]
    );
    if (rows.length === 0) {
      return res.json({ status: 'not-configured', accounts: [], detail: 'WhatsApp is not connected. Connect a number to receive leads.' });
    }
    const active = rows.filter(r => r.is_active);
    if (active.length === 0) {
      return res.json({
        status: 'incomplete',
        accounts: rows.map(publicAccount),
        detail: 'WhatsApp accounts exist but none is active.',
      });
    }
    const bad = active.filter(r => r.health_status === 'invalid_token' || r.health_status === 'rate_limited' || r.health_status === 'unknown_error');
    if (bad.length > 0) {
      return res.json({
        status: 'error',
        accounts: rows.map(publicAccount),
        detail: bad[0].last_error_message || 'A WhatsApp account reported an error. Check the token.',
      });
    }
    const pending = active.filter(r => !r.health_status || r.health_status === 'unknown');
    if (pending.length > 0 && !active.some(r => r.health_status === 'healthy')) {
      return res.json({
        status: 'verification-pending',
        accounts: rows.map(publicAccount),
        detail: 'WhatsApp is configured. Verification is pending — send a test message or wait for the next sync.',
      });
    }
    return res.json({
      status: 'connected',
      accounts: rows.map(publicAccount),
      detail: `${active.length} WhatsApp number(s) connected.`,
    });
  } catch (err) {
    // Pre-migration DBs (no organization_id column yet): fall back to a
    // global count so the endpoint never 500s during rollout.
    try {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM coexistence.whatsapp_accounts`);
      if ((rows[0]?.n || 0) === 0) {
        return res.json({ status: 'not-configured', accounts: [], detail: 'WhatsApp is not connected.' });
      }
      return res.json({ status: 'verification-pending', accounts: [], detail: 'WhatsApp accounts exist. Verification pending.' });
    } catch {
      console.error('[settings] whatsapp-status error:', err.message);
      return res.status(500).json({ error: 'Failed to load WhatsApp status' });
    }
  }
});

function publicAccount(r) {
  return {
    id: r.id,
    displayName: r.display_name,
    displayPhoneNumber: r.display_phone_number,
    isActive: r.is_active,
    isDefault: r.is_default,
    healthStatus: r.health_status || 'unknown',
    lastErrorMessage: r.last_error_message || null,
    lastErrorAt: r.last_error_at || null,
    lastSuccessAt: r.last_success_at || null,
  };
}

// --- Onboarding overview hub --------------------------------------------------
// One call for the onboarding wizard: org + onboarding + whatsapp + ai + counts.
router.get('/settings/overview', requireOrg, async (req, res) => {
  try {
    const { rows: orgRows } = await pool.query(
      `SELECT id, name, slug, plan, timezone, locale, business_name, onboarding_completed_at
         FROM coexistence.organizations WHERE id = $1`,
      [req.org.id]
    );
    if (!orgRows[0]) return res.status(404).json({ error: 'Organization not found' });
    const { state, completedAt } = await loadOnboardingState(pool, req.org.id);
    const derived = await computeOnboardingStatus(pool, req.org.id);

    // WhatsApp summary (counts only — full state via /whatsapp-status).
    let whatsapp = { total: 0, active: 0 };
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active)::int AS active
           FROM coexistence.whatsapp_accounts WHERE organization_id = $1`,
        [req.org.id]
      );
      whatsapp = { total: rows[0]?.total || 0, active: rows[0]?.active || 0 };
    } catch { /* pre-migration — leave zeros */ }

    // Team size.
    let teamSize = 1;
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM coexistence.organization_members WHERE organization_id = $1`,
        [req.org.id]
      );
      teamSize = rows[0]?.n || 1;
    } catch { /* ignore */ }

    // AI entitlement snapshot (best-effort, mirrors /v1/ai/status logic).
    let ai = { entitled: false, granted: 0, used: 0, remaining: 0 };
    try {
      const { subscriptionState, ensureSubscription } = require('../billing/subscriptions');
      const { orgQuotaSnapshot } = require('../billing/quotas');
      const sub = await ensureSubscription(pool, req.org.id);
      ai.entitled = !!subscriptionState(sub).entitled;
      const usage = await orgQuotaSnapshot(pool, req.org.id);
      ai = { entitled: ai.entitled, granted: usage.granted, used: usage.used, remaining: usage.remaining };
    } catch { /* billing tables may predate — leave defaults */ }

    // Automation + CRM counts (best-effort).
    let automations = 0;
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM coexistence.automations WHERE organization_id = $1`, [req.org.id]
      );
      automations = rows[0]?.n || 0;
    } catch {
      try {
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM coexistence.chatbots WHERE organization_id = $1`, [req.org.id]
        );
        automations = rows[0]?.n || 0;
      } catch { /* ignore */ }
    }
    let pipelines = 0;
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM coexistence.pipelines WHERE organization_id = $1`, [req.org.id]
      );
      pipelines = rows[0]?.n || 0;
    } catch { /* ignore */ }

    res.json({
      organization: { ...orgShape(orgRows[0]), role: req.org.role },
      onboarding: { stored: state, completedAt, derived, completed: derived.completed },
      whatsapp,
      team: { size: teamSize },
      ai,
      automation: { count: automations },
      crm: { pipelines },
    });
  } catch (err) {
    console.error('[settings] overview error:', err.message);
    res.status(500).json({ error: 'Failed to load settings overview' });
  }
});

module.exports = { router };
