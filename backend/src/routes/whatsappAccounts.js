const { Router } = require('express');
const pool = require('../db');
const { encrypt, decrypt, maskSecret } = require('../util/crypto');
const { adminOnly, adminOrOrgManager } = require('../middleware/access');
const { requireOrg } = require('../middleware/tenant');
const { isAdmin } = require('../permissions');
const {
  MetaError,
  getEmbeddedSignupConfig,
  verifySignupState,
} = require('../services/metaEmbeddedSignup');
const {
  CONNECTION_STATES,
  HEALTH_STATES,
  ProvisioningError,
  provisionWhatsAppAccount,
  verifyConnectionHealth,
  disconnectWhatsAppAccount,
} = require('../services/whatsappProvisioning');

const router = Router();

/**
 * Look up a phone number's human-readable number + verified business name from
 * the Meta Graph API. The simplified connection form no longer asks the user to
 * type these, so we derive them from the Phone Number ID + access token. Also
 * doubles as a credential check. Throws on a non-2xx Meta response.
 */
async function fetchPhoneMeta(phoneNumberId, accessToken) {
  const version = process.env.META_API_VERSION || 'v21.0';
  const apiUrl = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`;
  const resp = await fetch(apiUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await resp.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!resp.ok) {
    throw new Error(body?.error?.message || text || `HTTP ${resp.status}`);
  }
  return body; // { display_phone_number, verified_name, id }
}

// Serialise an account row for the API. Secrets — the masked access token and
// the webhook verify token — are ONLY included for admins (`includeSecrets`).
// The full (decrypted) access token is never sent over the API at all.
function publicShape(row, { includeSecrets = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    organizationId: row.organization_id || null,
    displayName: row.display_name,
    displayPhoneNumber: row.display_phone_number,
    phoneNumberId: row.phone_number_id,
    wabaId: row.waba_id,
    metaAppId: row.meta_app_id,
    isDefault: row.is_default,
    isActive: row.is_active,
    connectionStatus: row.connection_status || (row.is_active ? CONNECTION_STATES.CONNECTED : CONNECTION_STATES.DISCONNECTED),
    businessId: row.business_id || null,
    metadata: row.metadata || {},
    disconnectedAt: row.disconnected_at || null,
    webhookSubscribed: Boolean(row.webhook_subscribed),
    webhookVerifiedAt: row.webhook_verified_at || null,
    registeredAt: row.registered_at || null,
    healthStatus: row.health_status || 'unknown',
    lastErrorAt: row.last_error_at,
    lastErrorMessage: row.last_error_message,
    lastSuccessAt: row.last_success_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeSecrets) {
    out.accessTokenMasked = row.access_token_encrypted ? maskSecret(decrypt(row.access_token_encrypted)) : null;
    out.verifyToken = row.verify_token_encrypted ? decrypt(row.verify_token_encrypted) : '';
  }
  return out;
}

// List accounts. With an org context, returns the org's accounts PLUS legacy
// unassigned (organization_id NULL) rows (dual-read until the approval-gated
// backfill assigns them). Without org context, legacy global behavior.
router.get('/whatsapp-accounts', async (req, res) => {
  try {
    const orgId = req.org?.id || null;
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.whatsapp_accounts
        WHERE ($1::boolean IS NULL OR is_active = $1)
          AND ($2::uuid IS NULL OR organization_id IS NULL OR organization_id = $2)
        ORDER BY is_default DESC, display_name ASC`,
      [req.query.activeOnly === 'true' ? true : null, orgId]
    );
    const includeSecrets = isAdmin(req.user);
    res.json(rows.map(r => publicShape(r, { includeSecrets })));
  } catch (err) {
    console.error('[whatsapp-accounts] list error:', err.message);
    res.status(500).json({ error: 'Failed to list WhatsApp Business accounts' });
  }
});

// Resolve account by phone (must be registered before :id so it doesn't match :id=by-phone)
router.get('/whatsapp-accounts/by-phone/:phone', async (req, res) => {
  try {
    const acc = await getAccountByPhoneNumber(req.params.phone);
    if (!acc) return res.status(404).json({ error: 'No WhatsApp Business account registered for this phone' });
    res.json({
      id: acc.id,
      displayName: acc.displayName,
      displayPhoneNumber: acc.displayPhoneNumber,
      phoneNumberId: acc.phoneNumberId,
      wabaId: acc.wabaId,
      isActive: acc.isActive,
    });
  } catch (err) {
    console.error('[whatsapp-accounts] by-phone error:', err.message);
    res.status(500).json({ error: 'Failed to resolve account' });
  }
});

// Get one — admin only; returns the masked token + verify token (never the
// full access token). Cross-org reads return 404 (no existence leak).
router.get('/whatsapp-accounts/:id', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.whatsapp_accounts
        WHERE id = $1
          AND ($2::uuid IS NULL OR organization_id IS NULL OR organization_id = $2)`,
      [req.params.id, req.org?.id || null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(publicShape(rows[0], { includeSecrets: true }));
  } catch (err) {
    console.error('[whatsapp-accounts] get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch WhatsApp Business account' });
  }
});

router.post('/whatsapp-accounts', adminOrOrgManager, async (req, res) => {
  try {
    const { phoneNumberId, wabaId, accessToken, verifyToken, metaAppId } = req.body || {};
    if (!phoneNumberId || !wabaId || !accessToken) {
      return res.status(400).json({ error: 'Phone Number ID, WhatsApp Business Account ID and Permanent Access Token are required' });
    }

    // Green Pilot ownership: accounts belong to an organization. With an org
    // context, the "only one account" cap is per-organization (an org may
    // connect several numbers; the first becomes default). Without org context
    // (legacy single-owner installs), the original global cap is preserved so
    // behavior is unchanged until the backfill lands.
    const orgId = req.org?.id || null;
    if (!orgId) {
      // Legacy single-owner installs: preserve the original global cap until
      // the approval-gated backfill assigns accounts to organizations.
      const { rows: existing } = await pool.query('SELECT COUNT(*)::int AS n FROM coexistence.whatsapp_accounts');
      if (existing[0].n >= 1) {
        return res.status(409).json({ error: 'Only one WhatsApp Business account is allowed. Edit the existing account instead.' });
      }
    }
    // With an org context there is intentionally NO per-org cap: an
    // organization may own several WhatsApp numbers (first becomes default).

    // Best-effort: resolve the human-readable number + verified business name
    // from Meta so chat threading and display still work without the user
    // typing them. Saving proceeds even if the lookup fails (logged).
    let displayName = `WhatsApp ${wabaId.trim()}`;
    let displayPhoneNumber = '';
    try {
      const meta = await fetchPhoneMeta(phoneNumberId.trim(), accessToken.trim());
      if (meta.verified_name) displayName = meta.verified_name;
      if (meta.display_phone_number) displayPhoneNumber = String(meta.display_phone_number).replace(/\D/g, '');
    } catch (e) {
      // Don't save a half-working account. The lookup doubles as a credential
      // check, so a failure here means the Phone Number ID + token combination
      // can't talk to Meta (wrong ID, wrong app, or an expired token — a Meta
      // *test number*'s token expires every 24h). Surface Meta's reason.
      console.warn('[whatsapp-accounts] Meta credential check failed:', e.message);
      return res.status(400).json({
        error: `Couldn't verify this WhatsApp number with Meta. Double-check your Phone Number ID and access token (a test number's token expires every 24 hours). Meta said: ${e.message}`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // First account in an org scope becomes default + active (dual-read scope:
      // the org's own accounts plus legacy unassigned rows).
      const { rows: scopeCount } = await client.query(
        `SELECT COUNT(*)::int AS n FROM coexistence.whatsapp_accounts
          WHERE ($1::uuid IS NULL OR organization_id IS NULL OR organization_id = $1)`,
        [orgId]
      );
      const makeDefault = scopeCount[0].n === 0;
      // The lone account is always the default and active.
      const { rows } = await client.query(
        `INSERT INTO coexistence.whatsapp_accounts
          (display_name, display_phone_number, phone_number_id, waba_id, meta_app_id,
           access_token_encrypted, verify_token_encrypted, is_default, is_active,
           organization_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9)
          RETURNING *`,
        [
          displayName, displayPhoneNumber, phoneNumberId.trim(), wabaId.trim(),
          metaAppId?.trim() || null,
          encrypt(accessToken.trim()), encrypt((verifyToken || '').trim()),
          makeDefault, orgId,
        ]
      );
      await client.query('COMMIT');
      res.status(201).json(publicShape(rows[0], { includeSecrets: true }));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This Phone Number ID is already connected' });
    console.error('[whatsapp-accounts] create error:', err.message);
    res.status(500).json({ error: 'Failed to create WhatsApp Business account' });
  }
});

router.put('/whatsapp-accounts/:id', adminOrOrgManager, async (req, res) => {
  try {
    const { phoneNumberId, wabaId, accessToken, verifyToken, metaAppId, isActive } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Org ownership enforced: cross-org updates return 404 (no existence leak).
      const { rows: existingRows } = await client.query(
        `SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1
          AND ($2::uuid IS NULL OR organization_id IS NULL OR organization_id = $2)`,
        [req.params.id, req.org?.id || null]
      );
      if (existingRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
      const ex = existingRows[0];

      const newPhoneId = phoneNumberId != null ? phoneNumberId.trim() : ex.phone_number_id;
      const newWaba = wabaId != null ? wabaId.trim() : ex.waba_id;
      const tokenChanged = !!(accessToken && accessToken.trim());
      const effectiveToken = tokenChanged ? accessToken.trim() : decrypt(ex.access_token_encrypted);

      // Re-derive the display fields from Meta when the number or token changes.
      let displayName = ex.display_name;
      let displayPhoneNumber = ex.display_phone_number;
      if ((phoneNumberId != null && newPhoneId !== ex.phone_number_id) || tokenChanged) {
        try {
          const meta = await fetchPhoneMeta(newPhoneId, effectiveToken);
          if (meta.verified_name) displayName = meta.verified_name;
          if (meta.display_phone_number) displayPhoneNumber = String(meta.display_phone_number).replace(/\D/g, '');
        } catch (e) {
          // Same credential check as on connect: if the changed number/token
          // can't reach Meta, refuse the update and tell the user why instead
          // of silently keeping stale values.
          console.warn('[whatsapp-accounts] Meta credential check failed on update:', e.message);
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Couldn't verify this WhatsApp number with Meta. Double-check your Phone Number ID and access token (a test number's token expires every 24 hours). Meta said: ${e.message}`,
          });
        }
      }

      const sets = ['updated_at = NOW()'];
      const params = [];
      let i = 1;
      const push = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };
      push('display_name', displayName);
      push('display_phone_number', displayPhoneNumber);
      push('phone_number_id', newPhoneId);
      push('waba_id', newWaba);
      if (metaAppId !== undefined) push('meta_app_id', metaAppId?.trim() || null);
      if (tokenChanged) {
        push('access_token_encrypted', encrypt(effectiveToken));
        // Reset health on token update so the UI banner clears.
        push('health_status', 'unknown');
        push('last_error_message', null);
      }
      if (verifyToken !== undefined) push('verify_token_encrypted', encrypt((verifyToken || '').trim()));
      if (isActive != null) push('is_active', !!isActive);
      params.push(req.params.id);
      const { rows } = await client.query(
        `UPDATE coexistence.whatsapp_accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        params
      );
      await client.query('COMMIT');
      res.json(publicShape(rows[0], { includeSecrets: true }));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This Phone Number ID is already connected' });
    console.error('[whatsapp-accounts] update error:', err.message);
    res.status(500).json({ error: 'Failed to update WhatsApp Business account' });
  }
});

router.delete('/whatsapp-accounts/:id', adminOrOrgManager, async (req, res) => {
  try {
    // Never delete the last account in scope — it would stop all sends. Legacy
    // installs keep the global guard; org contexts get the same guard scoped to
    // (org's accounts + legacy unassigned). To switch numbers, edit instead.
    const orgId = req.org?.id || null;
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.whatsapp_accounts
        WHERE ($1::uuid IS NULL OR organization_id IS NULL OR organization_id = $1)`,
      [orgId]
    );
    if (cnt[0].n <= 1) {
      return res.status(409).json({ error: 'Cannot delete the only WhatsApp Business account. Edit it to change the connected number.' });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.whatsapp_accounts
        WHERE id = $1
          AND ($2::uuid IS NULL OR organization_id IS NULL OR organization_id = $2)`,
      [req.params.id, orgId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[whatsapp-accounts] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete WhatsApp Business account' });
  }
});

// ── Meta WhatsApp Embedded Signup v4 ─────────────────────────────────────────

// GET /whatsapp-accounts/embedded-signup/config (and /integrations/whatsapp/config)
const handleGetSignupConfig = async (req, res) => {
  try {
    const config = getEmbeddedSignupConfig({
      userId: req.user.id,
      organizationId: req.org.id,
    });
    res.json(config);
  } catch (err) {
    if (err instanceof MetaError || err.status) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code || 'config-error' });
    }
    console.error('[whatsapp:embedded-signup] config error:', err.message);
    res.status(500).json({ error: 'Failed to get Embedded Signup configuration' });
  }
};
router.get('/whatsapp-accounts/embedded-signup/config', requireOrg, adminOrOrgManager, handleGetSignupConfig);
router.get('/integrations/whatsapp/config', requireOrg, adminOrOrgManager, handleGetSignupConfig);

// POST /whatsapp-accounts/embedded-signup/complete (and /integrations/whatsapp/embedded-signup)
const handleCompleteSignup = async (req, res) => {
  const { code, wabaId, phoneNumberId, businessId, state } = req.body || {};
  if (!code) {
    return res.status(400).json({ error: 'Authorization code from Meta is required', code: 'missing-code' });
  }

  try {
    // 1. Verify tenant-bound state parameter to prevent cross-tenant / account swapping
    verifySignupState(state, {
      expectedUserId: req.user.id,
      expectedOrgId: req.org.id,
    });

    // 2. Complete WhatsApp account provisioning through dedicated service
    const account = await provisionWhatsAppAccount({
      organizationId: req.org.id,
      code,
      wabaId,
      phoneNumberId,
      businessId,
      db: pool,
    });

    res.status(201).json({
      ok: true,
      account: publicShape(account, { includeSecrets: isAdmin(req.user) }),
    });
  } catch (err) {
    if (err instanceof MetaError || err instanceof ProvisioningError || err.status) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code || 'provisioning_error' });
    }
    console.error('[whatsapp:embedded-signup] complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete WhatsApp Embedded Signup' });
  }
};
router.post('/whatsapp-accounts/embedded-signup/complete', requireOrg, adminOrOrgManager, handleCompleteSignup);
router.post('/integrations/whatsapp/embedded-signup', requireOrg, adminOrOrgManager, handleCompleteSignup);

// POST /whatsapp-accounts/:id/verify (and /integrations/whatsapp/verify, GET /whatsapp-accounts/:id/health)
// On-demand connection health verification without exposing credentials
const handleVerifyHealth = async (req, res) => {
  const accountId = req.params.id || req.body?.accountId;
  try {
    const report = await verifyConnectionHealth({
      accountId,
      organizationId: req.org.id,
      db: pool,
    });
    res.json({ ok: true, health: report });
  } catch (err) {
    if (err instanceof MetaError || err instanceof ProvisioningError || err.status) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code || 'verify_error' });
    }
    console.error('[whatsapp:verify] error:', err.message);
    res.status(500).json({ error: 'Failed to verify WhatsApp connection' });
  }
};
router.post('/whatsapp-accounts/:id/verify', requireOrg, adminOrOrgManager, handleVerifyHealth);
router.get('/whatsapp-accounts/:id/health', requireOrg, adminOrOrgManager, handleVerifyHealth);
router.post('/integrations/whatsapp/verify', requireOrg, adminOrOrgManager, handleVerifyHealth);

// POST /whatsapp-accounts/:id/disconnect (and /integrations/whatsapp/disconnect)
// Safe disconnect: marks connection inactive and disconnected while preserving all CRM leads and conversations.
const handleDisconnect = async (req, res) => {
  const accountId = req.params.id || req.body?.accountId;
  try {
    const updated = await disconnectWhatsAppAccount({
      accountId,
      organizationId: req.org.id,
      db: pool,
    });
    res.json({ ok: true, success: true, account: publicShape(updated, { includeSecrets: isAdmin(req.user) }) });
  } catch (err) {
    if (err instanceof MetaError || err instanceof ProvisioningError || err.status) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code || 'disconnect-error' });
    }
    console.error('[whatsapp:disconnect] error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect WhatsApp account' });
  }
};
router.post('/whatsapp-accounts/:id/disconnect', requireOrg, adminOrOrgManager, handleDisconnect);
router.post('/integrations/whatsapp/disconnect', requireOrg, adminOrOrgManager, handleDisconnect);

// Normalise phone numbers for matching: strip everything but digits.
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

function rowToCreds(r) {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id || null,
    displayName: r.display_name,
    displayPhoneNumber: r.display_phone_number,
    phoneNumberId: r.phone_number_id,
    wabaId: r.waba_id,
    accessToken: decrypt(r.access_token_encrypted),
    isActive: r.is_active,
  };
}

async function getAccountWithToken(accountId) {
  const { rows } = await pool.query(
    'SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1',
    [accountId]
  );
  return rowToCreds(rows[0]);
}

/**
 * Return the single connected account (this product is capped at one). Used as
 * a fallback when phone-number matching can't resolve an account — e.g. the
 * display number hasn't been derived from Meta yet.
 */
async function getSingleAccount() {
  const { rows } = await pool.query(
    'SELECT * FROM coexistence.whatsapp_accounts ORDER BY is_default DESC, id ASC LIMIT 1'
  );
  return rowToCreds(rows[0]);
}

/**
 * Resolve the WhatsApp account that owns the given phone number. Used by
 * broadcasts and automation message nodes to derive credentials from a
 * "from" phone number. Matches by digits-only normalisation so users can
 * register the number as "+919342245724" or "919342245724".
 */
async function getAccountByPhoneNumber(phoneOrId) {
  const norm = normalizePhone(phoneOrId);
  if (!norm) return null;
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.whatsapp_accounts
       WHERE regexp_replace(display_phone_number, '\\D', '', 'g') = $1
          OR phone_number_id = $2
       LIMIT 1`,
    [norm, String(phoneOrId)]
  );
  return rowToCreds(rows[0]);
}

/**
 * Resolve the organization that owns a WhatsApp account by Meta phone_number_id.
 * Used by the webhook layer to derive tenant context. Returns
 * { accountId, organizationId } with organizationId null for legacy unassigned
 * accounts, or null when no account matches (unknown number → reject/skip).
 */
async function getAccountOrgByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const { rows } = await pool.query(
    `SELECT id, organization_id FROM coexistence.whatsapp_accounts
      WHERE phone_number_id = $1 LIMIT 1`,
    [String(phoneNumberId)]
  );
  if (!rows[0]) return null;
  return { accountId: rows[0].id, organizationId: rows[0].organization_id || null };
}

module.exports = { router, getAccountWithToken, getAccountByPhoneNumber, getSingleAccount, getAccountOrgByPhoneNumberId };
