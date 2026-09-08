// Green Pilot — Phase 2: Meta WhatsApp Embedded Signup v4 Service
//
// Manages:
// - Signed, tenant-bound CSRF state tokens for Embedded Signup
// - Meta Graph API OAuth code exchange for permanent/system access tokens
// - WABA and phone number discovery
// - Webhook app subscription for WABAs
// - Secure credential encryption and account provisioning
// - Safe disconnection without deleting CRM contacts, chats, or leads

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { encrypt, decrypt } = require('../util/crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'forgecrm-dev-secret-change-me';
const STATE_EXPIRY = '15m';

class MetaError extends Error {
  constructor(message, status = 400, code = 'meta-error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Test / Mock handler hook for automated testing without calling live Meta servers
let testMetaHandler = null;
function setTestMetaHandler(fn) {
  testMetaHandler = fn;
}

/**
 * Generates a signed, tamper-proof state parameter binding the current user and organization.
 */
function generateSignupState({ userId, organizationId }) {
  if (!userId || !organizationId) {
    throw new MetaError('User and organization context required for signup state', 400, 'missing-context');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  return jwt.sign(
    {
      sub: String(userId),
      orgId: String(organizationId),
      nonce,
      action: 'whatsapp_embedded_signup',
    },
    JWT_SECRET,
    { expiresIn: STATE_EXPIRY }
  );
}

/**
 * Verifies that the returned state token matches the expected user and organization.
 */
function verifySignupState(stateToken, { expectedUserId, expectedOrgId }) {
  if (!stateToken || typeof stateToken !== 'string') {
    throw new MetaError('Missing or invalid state parameter', 400, 'missing-state');
  }
  let payload;
  try {
    payload = jwt.verify(stateToken.trim(), JWT_SECRET);
  } catch (err) {
    throw new MetaError('State parameter expired or invalid', 403, 'expired-state');
  }

  if (payload.action !== 'whatsapp_embedded_signup') {
    throw new MetaError('Invalid state action', 403, 'invalid-state-action');
  }
  if (String(payload.sub) !== String(expectedUserId)) {
    throw new MetaError('User context mismatch on state verification', 403, 'user-mismatch');
  }
  if (String(payload.orgId) !== String(expectedOrgId)) {
    throw new MetaError('Organization context mismatch on state verification', 403, 'org-mismatch');
  }
  return payload;
}

/**
 * Returns the public configuration needed by the frontend to render the Embedded Signup button.
 */
function getEmbeddedSignupConfig({ userId, organizationId }) {
  const appId = process.env.META_APP_ID || '';
  const configId = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || '';
  const apiVersion = process.env.META_API_VERSION || 'v21.0';
  const configured = Boolean(appId && process.env.META_APP_SECRET);

  const state = generateSignupState({ userId, organizationId });
  return {
    appId,
    configId,
    apiVersion,
    state,
    configured,
  };
}

/**
 * Exchanges the authorization code received from Embedded Signup for an access token.
 */
async function exchangeCodeForToken(code) {
  if (!code || typeof code !== 'string') {
    throw new MetaError('Authorization code is required', 400, 'missing-code');
  }

  if (testMetaHandler) {
    const mockRes = await testMetaHandler('exchangeCode', { code });
    if (mockRes) return mockRes.accessToken;
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const version = process.env.META_API_VERSION || 'v21.0';

  if (!appId || !appSecret) {
    if (process.env.NODE_ENV === 'production') {
      throw new MetaError('Meta App ID and Secret are not configured on the server', 503, 'misconfigured-meta');
    }
    // Dev fallback mock token
    return `mock-meta-token-${Date.now()}`;
  }

  const url = `https://graph.facebook.com/${version}/oauth/access_token?client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code.trim())}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    console.error('[meta:embedded-signup] Code exchange failed:', data);
    throw new MetaError(data?.error?.message || 'Failed to exchange authorization code with Meta', 400, 'exchange-failed');
  }
  return data.access_token;
}

/**
 * Fetches phone numbers under a WABA from Meta Graph API.
 */
async function fetchWabaPhoneNumbers({ wabaId, accessToken }) {
  if (testMetaHandler) {
    const mockRes = await testMetaHandler('fetchPhoneNumbers', { wabaId, accessToken });
    if (mockRes) return mockRes.phoneNumbers;
  }

  const version = process.env.META_API_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(data?.data)) {
    console.warn('[meta:embedded-signup] Failed to fetch phone numbers for WABA:', wabaId, data);
    return [];
  }
  return data.data;
}

/**
 * Subscribes a WABA to the Green Pilot application webhook.
 */
async function subscribeWabaWebhook({ wabaId, accessToken }) {
  if (testMetaHandler) {
    const mockRes = await testMetaHandler('subscribeWebhook', { wabaId, accessToken });
    if (mockRes) return mockRes.success;
  }

  const version = process.env.META_API_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/subscribed_apps`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    return Boolean(data?.success);
  } catch (err) {
    console.warn('[meta:embedded-signup] Webhook subscription error:', err.message);
    return false;
  }
}

/**
 * Provisions or updates a WhatsApp connection in coexistence.whatsapp_accounts.
 * Idempotent: repeated connections update credentials and re-activate cleanly.
 */
async function provisionWhatsAppConnection({
  db = pool,
  organizationId,
  wabaId,
  phoneNumberId,
  displayName,
  displayPhoneNumber,
  accessToken,
  metaAppId = null,
  businessId = null,
  metadata = {},
}) {
  const cleanOrgId = organizationId;
  const cleanWaba = String(wabaId || '').trim();
  const cleanPhoneId = String(phoneNumberId || '').trim();
  const cleanDisplayPhone = String(displayPhoneNumber || '').replace(/\D/g, '');
  const cleanName = String(displayName || `WhatsApp ${cleanPhoneId}`).trim().slice(0, 200);

  if (!cleanWaba || !cleanPhoneId) {
    throw new MetaError('WABA ID and Phone Number ID are required to provision connection', 400, 'missing-ids');
  }

  // Generate a random webhook verify token for this account
  const verifyToken = crypto.randomBytes(24).toString('hex');
  const encAccessToken = encrypt(accessToken.trim());
  const encVerifyToken = encrypt(verifyToken);

  const client = db.connect ? await db.connect() : db;
  const release = db.connect ? () => client.release() : () => {};

  try {
    if (db.connect) await client.query('BEGIN');

    // Determine if this is the first account for this organization
    const { rows: existingCount } = await client.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.whatsapp_accounts
        WHERE organization_id = $1`,
      [cleanOrgId]
    );
    const isDefault = existingCount[0].n === 0;

    // Check if account already exists for this phone_number_id (reconnect/update)
    const { rows: existing } = await client.query(
      `SELECT id, organization_id FROM coexistence.whatsapp_accounts
        WHERE phone_number_id = $1`,
      [cleanPhoneId]
    );

    let row = null;
    if (existing.length > 0) {
      // Reconnection: update credentials and set active
      const { rows: updated } = await client.query(
        `UPDATE coexistence.whatsapp_accounts
            SET display_name = $1,
                display_phone_number = $2,
                waba_id = $3,
                meta_app_id = COALESCE($4, meta_app_id),
                access_token_encrypted = $5,
                verify_token_encrypted = $6,
                is_active = TRUE,
                connection_status = 'connected',
                disconnected_at = NULL,
                business_id = COALESCE($7, business_id),
                metadata = $8::jsonb,
                health_status = 'healthy',
                last_error_message = NULL,
                updated_at = NOW()
          WHERE id = $9
          RETURNING *`,
        [
          cleanName,
          cleanDisplayPhone,
          cleanWaba,
          metaAppId,
          encAccessToken,
          encVerifyToken,
          businessId,
          JSON.stringify(metadata),
          existing[0].id,
        ]
      );
      row = updated[0];
    } else {
      // Fresh insertion
      const { rows: inserted } = await client.query(
        `INSERT INTO coexistence.whatsapp_accounts
           (display_name, display_phone_number, phone_number_id, waba_id, meta_app_id,
            access_token_encrypted, verify_token_encrypted, is_default, is_active,
            organization_id, connection_status, business_id, metadata, health_status)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, 'connected', $10, $11::jsonb, 'healthy')
         RETURNING *`,
        [
          cleanName,
          cleanDisplayPhone,
          cleanPhoneId,
          cleanWaba,
          metaAppId,
          encAccessToken,
          encVerifyToken,
          isDefault,
          cleanOrgId,
          businessId,
          JSON.stringify(metadata),
        ]
      );
      row = inserted[0];
    }

    if (db.connect) await client.query('COMMIT');
    return row;
  } catch (err) {
    if (db.connect) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    throw err;
  } finally {
    release();
  }
}

/**
 * Safely disconnects a WhatsApp account by marking it inactive and disconnected.
 * Preserves all CRM contacts, chats, messages, and templates intact.
 */
async function disconnectWhatsAppAccount({ accountId, organizationId, db = pool }) {
  if (!accountId) {
    throw new MetaError('Account ID is required to disconnect', 400, 'missing-account-id');
  }

  const { rows } = await db.query(
    `UPDATE coexistence.whatsapp_accounts
        SET is_active = FALSE,
            connection_status = 'disconnected',
            disconnected_at = NOW(),
            health_status = 'disconnected',
            updated_at = NOW()
      WHERE id = $1
        AND ($2::uuid IS NULL OR organization_id IS NULL OR organization_id = $2)
      RETURNING id, display_name, display_phone_number, phone_number_id, waba_id, connection_status, is_active`,
    [accountId, organizationId || null]
  );

  if (rows.length === 0) {
    throw new MetaError('WhatsApp account not found or unauthorized', 404, 'not-found');
  }
  return rows[0];
}

module.exports = {
  MetaError,
  generateSignupState,
  verifySignupState,
  getEmbeddedSignupConfig,
  exchangeCodeForToken,
  fetchWabaPhoneNumbers,
  subscribeWabaWebhook,
  provisionWhatsAppConnection,
  disconnectWhatsAppAccount,
  setTestMetaHandler,
};
