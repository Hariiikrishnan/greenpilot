// Phase 12 secure team invitations (canonical: /api/v1/orgs/:id/invitations/*).
//
// Security model:
//   - Create/list/revoke: org owner/admin only, org taken from the AUTHORIZED
//     route param (:id must match a membership — verified here, not trusted).
//   - Token: 256-bit random, stored as SHA-256 hex, 7-day expiry, single-use
//     (accepted_at), revocable (revoked_at). Raw token returned ONCE.
//   - Accept: the TOKEN establishes the org context. The client-supplied
//     organizationId (if any) is ignored — the invitation row is authoritative.
//   - Accepting requires authentication (the invitee must be a real user);
//     creates the membership row idempotently.

const { Router } = require('express');
const pool = require('../db');
const { assertMembership } = require('../tenancy/organizations');
const {
  mintInviteToken,
  hashInviteToken,
  validateInviteInput,
} = require('../onboarding/service');

const router = Router();
const INVITE_TTL_DAYS = 7;

function isManager(role) {
  return role === 'owner' || role === 'admin';
}

async function requireManagerOf(req, res, orgId) {
  const m = await assertMembership(pool, req.user.id, orgId);
  if (!m) {
    res.status(403).json({ error: 'Not a member of this organization', code: 'not-member' });
    return null;
  }
  if (!isManager(m.role)) {
    res.status(403).json({ error: 'Only owners and admins can manage invitations' });
    return null;
  }
  return m;
}

function inviteShape(r) {
  return {
    id: r.id,
    organizationId: r.organization_id,
    email: r.email,
    role: r.role,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at || null,
    revokedAt: r.revoked_at || null,
    createdAt: r.created_at,
  };
}

// POST /orgs/:id/invitations — create (or re-issue) an invite for an email.
router.post('/orgs/:id/invitations', async (req, res) => {
  try {
    const m = await requireManagerOf(req, res, req.params.id);
    if (!m) return;
    let email;
    let role;
    try {
      ({ email, role } = validateInviteInput(req.body || {}));
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    // Already a member? Refuse (idempotent no-op signal, not a leak).
    const { rows: existing } = await pool.query(
      `SELECT m.user_id FROM coexistence.organization_members m
         JOIN coexistence.forgecrm_users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND u.email = $2`,
      [req.params.id, email]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'That user is already a member', code: 'already-member' });
    }
    const { raw, hash } = mintInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    // One live invite per (org, email): revoke prior live rows, then insert.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE coexistence.organization_invitations SET revoked_at = NOW()
          WHERE organization_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [req.params.id, email]
      );
      const { rows } = await client.query(
        `INSERT INTO coexistence.organization_invitations
           (organization_id, email, role, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.params.id, email, role, hash, expiresAt, req.user.id]
      );
      await client.query('COMMIT');
      // Raw token returned once — the frontend shows it / emails it; the API
      // never returns it again (GET masks it).
      res.status(201).json({ ...inviteShape(rows[0]), token: raw });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '42P01' || /does not exist/i.test(err.message || '')) {
      return res.status(501).json({ error: 'Invitations not available — apply migration 070', code: 'migration-required' });
    }
    console.error('[invitations] create error:', err.message);
    res.status(500).json({ error: 'Failed to create invitation' });
  }
});

// GET /orgs/:id/invitations — list live + history (managers only, no tokens).
router.get('/orgs/:id/invitations', async (req, res) => {
  try {
    const m = await requireManagerOf(req, res, req.params.id);
    if (!m) return;
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.organization_invitations
        WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json(rows.map(inviteShape));
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(501).json({ error: 'Invitations not available — apply migration 070', code: 'migration-required' });
    }
    console.error('[invitations] list error:', err.message);
    res.status(500).json({ error: 'Failed to list invitations' });
  }
});

// POST /orgs/:id/invitations/:inviteId/revoke — managers only.
router.post('/orgs/:id/invitations/:inviteId/revoke', async (req, res) => {
  try {
    const m = await requireManagerOf(req, res, req.params.id);
    if (!m) return;
    const { rowCount } = await pool.query(
      `UPDATE coexistence.organization_invitations SET revoked_at = NOW()
        WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [req.params.inviteId, req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Invitation not found or already used' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[invitations] revoke error:', err.message);
    res.status(500).json({ error: 'Failed to revoke invitation' });
  }
});

// GET /invitations/:token — authenticated lookup (minimal: org name + email +
// expiry) so an invitee can preview before accepting. No membership data
// leaked. Accept still requires the signed-in email to match the invite.
router.get('/invitations/:token', async (req, res) => {
  try {
    const hash = hashInviteToken(req.params.token);
    const { rows } = await pool.query(
      `SELECT i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at,
              o.name AS org_name
         FROM coexistence.organization_invitations i
         JOIN coexistence.organizations o ON o.id = i.organization_id
        WHERE i.token_hash = $1`,
      [hash]
    );
    const inv = rows[0];
    if (!inv) return res.status(404).json({ error: 'Invitation not found' });
    if (inv.accepted_at) return res.status(410).json({ error: 'Invitation already used' });
    if (inv.revoked_at) return res.status(410).json({ error: 'Invitation revoked' });
    if (new Date(inv.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'Invitation expired' });
    }
    res.json({ organizationName: inv.org_name, email: inv.email, role: inv.role, expiresAt: inv.expires_at });
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(501).json({ error: 'Invitations not available — apply migration 070', code: 'migration-required' });
    }
    console.error('[invitations] lookup error:', err.message);
    res.status(500).json({ error: 'Failed to look up invitation' });
  }
});

// POST /invitations/:token/accept — authenticated. Token sets the org context;
// any client organizationId is ignored. Idempotent per (org, user).
router.post('/invitations/:token/accept', async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Sign in to accept the invitation' });
    const hash = hashInviteToken(req.params.token);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invite:${hash}`]);
      const { rows } = await client.query(
        `SELECT * FROM coexistence.organization_invitations WHERE token_hash = $1 FOR UPDATE`,
        [hash]
      );
      const inv = rows[0];
      if (!inv) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Invitation not found' });
      }
      if (inv.accepted_at || inv.revoked_at || new Date(inv.expires_at).getTime() < Date.now()) {
        await client.query('ROLLBACK');
        return res.status(410).json({ error: 'Invitation is no longer valid' });
      }
      // Email binding: the signed-in user's email must match the invite.
      const { rows: me } = await client.query(
        `SELECT email FROM coexistence.forgecrm_users WHERE id = $1`, [req.user.id]
      );
      if (!me[0] || String(me[0].email).toLowerCase() !== String(inv.email).toLowerCase()) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'This invitation was sent to a different email address' });
      }
      await client.query(
        `INSERT INTO coexistence.organization_members (organization_id, user_id, role)
          VALUES ($1, $2, $3)
          ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [inv.organization_id, req.user.id, inv.role]
      );
      // Phase 12: invited users can use the product without an instance
      // admin — merge page grants for the invite role (additive only, never
      // removes; org admins get setup tabs, members get team pages).
      try {
        const { OWNER_PAGE_GRANTS, MEMBER_PAGE_GRANTS, mergePageGrants } = require('../permissions');
        const { rows: u } = await client.query(
          `SELECT permissions FROM coexistence.forgecrm_users WHERE id = $1`, [req.user.id]
        );
        if (u[0]) {
          const grants = inv.role === 'admin' ? OWNER_PAGE_GRANTS : MEMBER_PAGE_GRANTS;
          await client.query(
            `UPDATE coexistence.forgecrm_users SET permissions = $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(mergePageGrants(u[0].permissions, grants)), req.user.id]
          );
        }
      } catch { /* grants are best-effort; membership already recorded */ }
      await client.query(
        `UPDATE coexistence.organization_invitations SET accepted_at = NOW() WHERE id = $1`,
        [inv.id]
      );
      await client.query('COMMIT');
      res.json({ ok: true, organizationId: inv.organization_id, role: inv.role });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[invitations] accept error:', err.message);
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

module.exports = { router };
