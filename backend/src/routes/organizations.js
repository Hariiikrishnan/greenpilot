// Green Pilot organization endpoints (canonical: /api/v1/orgs).
//
// - GET    /orgs                 — orgs I belong to
// - POST   /orgs                 — create org (I become owner)
// - GET    /orgs/:id/members     — list members (must be a member)
// - POST   /orgs/:id/members     — add member (owner/admin only)
// - DELETE /orgs/:id/members/:userId — remove member (owner only; last owner protected)

const { Router } = require('express');
const pool = require('../db');
const {
  listUserOrganizations,
  assertMembership,
  createOrganization,
} = require('../tenancy/organizations');

const router = Router();
const MEMBER_ROLES = new Set(['owner', 'admin', 'member']);

router.get('/orgs', async (req, res) => {
  try {
    const orgs = await listUserOrganizations(pool, req.user.id);
    res.json(orgs.map(o => ({
      id: o.organization_id || o.id,
      name: o.name,
      slug: o.slug,
      plan: o.plan,
      role: o.membership_role,
    })));
  } catch (err) {
    console.error('[orgs] list error:', err.message);
    res.status(500).json({ error: 'Failed to list organizations' });
  }
});

router.post('/orgs', async (req, res) => {
  try {
    // Safe retry: when the client sends Idempotency-Key, replays return the
    // stored first-attempt response instead of creating a duplicate org.
    const idemKey = String(req.get('Idempotency-Key') || '').trim().slice(0, 128);
    if (idemKey) {
      try {
        const { rows } = await pool.query(
          `SELECT status, response FROM coexistence.idempotency_keys
            WHERE user_id = $1 AND endpoint = 'POST /v1/orgs' AND client_key = $2`,
          [req.user.id, idemKey]
        );
        if (rows[0]) return res.status(rows[0].status).json(rows[0].response);
      } catch { /* pre-migration — proceed without idempotency */ }
    }
    const org = await createOrganization(pool, req.user.id, req.body || {});
    const body = { id: org.id, name: org.name, slug: org.slug, plan: org.plan, role: 'owner' };
    // Phase 12: a new org owner can use the product without an instance
    // admin — merge the owner page grants (additive, existing mechanism).
    try {
      const { OWNER_PAGE_GRANTS, mergePageGrants } = require('../permissions');
      const { rows: u } = await pool.query(
        `SELECT permissions FROM coexistence.forgecrm_users WHERE id = $1`, [req.user.id]
      );
      if (u[0]) {
        await pool.query(
          `UPDATE coexistence.forgecrm_users SET permissions = $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(mergePageGrants(u[0].permissions, OWNER_PAGE_GRANTS)), req.user.id]
        );
      }
    } catch { /* grants are best-effort; org creation already succeeded */ }
    if (idemKey) {
      try {
        await pool.query(
          `INSERT INTO coexistence.idempotency_keys (user_id, endpoint, client_key, status, response)
           VALUES ($1, 'POST /v1/orgs', $2, 201, $3::jsonb) ON CONFLICT DO NOTHING`,
          [req.user.id, idemKey, JSON.stringify(body)]
        );
      } catch { /* best-effort ledger */ }
    }
    res.status(201).json(body);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Organization slug already taken' });
    console.error('[orgs] create error:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Failed to create organization' });
  }
});

async function requireMember(req, res) {
  const m = await assertMembership(pool, req.user.id, req.params.id);
  if (!m) {
    res.status(403).json({ error: 'Not a member of this organization', code: 'not-member' });
    return null;
  }
  return m;
}

router.get('/orgs/:id/members', async (req, res) => {
  try {
    const m = await requireMember(req, res);
    if (!m) return;
    const { rows } = await pool.query(
      `SELECT m.user_id, u.email, u.display_name, m.role, m.created_at
         FROM coexistence.organization_members m
         JOIN coexistence.forgecrm_users u ON u.id = m.user_id
        WHERE m.organization_id = $1
        ORDER BY m.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[orgs] members error:', err.message);
    res.status(500).json({ error: 'Failed to list members' });
  }
});

router.post('/orgs/:id/members', async (req, res) => {
  try {
    const m = await requireMember(req, res);
    if (!m) return;
    if (m.role !== 'owner' && m.role !== 'admin') {
      return res.status(403).json({ error: 'Only owners and admins can add members' });
    }
    const { email, userId, role = 'member' } = req.body || {};
    if (!MEMBER_ROLES.has(role) || role === 'owner') {
      return res.status(400).json({ error: 'Role must be admin or member' });
    }
    let targetId = userId;
    if (!targetId && email) {
      const { rows } = await pool.query(
        'SELECT id FROM coexistence.forgecrm_users WHERE email = $1',
        [String(email).trim().toLowerCase()]
      );
      if (!rows[0]) return res.status(404).json({ error: 'No user with that email' });
      targetId = rows[0].id;
    }
    if (!targetId) return res.status(400).json({ error: 'userId or email is required' });
    await pool.query(
      `INSERT INTO coexistence.organization_members (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [req.params.id, targetId, role]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[orgs] add-member error:', err.message);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

router.delete('/orgs/:id/members/:userId', async (req, res) => {
  try {
    const m = await requireMember(req, res);
    if (!m) return;
    if (m.role !== 'owner') {
      return res.status(403).json({ error: 'Only owners can remove members' });
    }
    if (String(req.params.userId) === String(req.user.id)) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM coexistence.organization_members
          WHERE organization_id = $1 AND role = 'owner'`,
        [req.params.id]
      );
      if (rows[0].n <= 1) {
        return res.status(409).json({ error: 'Cannot remove the last owner' });
      }
    }
    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.organization_members
        WHERE organization_id = $1 AND user_id = $2`,
      [req.params.id, req.params.userId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not a member' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[orgs] remove-member error:', err.message);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

module.exports = { router };
