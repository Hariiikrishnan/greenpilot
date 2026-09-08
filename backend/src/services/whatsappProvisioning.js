// Green Pilot — Phase 3: WhatsApp Provisioning Service
//
// Manages:
// - WABA discovery and business metadata
// - Phone number discovery and verification
// - Phone number registration for WhatsApp Cloud API
// - WABA webhook application subscription and verification
// - Connection state transitions (PENDING, CONNECTING, CONNECTED, ERROR, DISCONNECTED)
// - Connection health verification without exposing credentials
// - Idempotent provisioning and safe disconnection preserving CRM data

const pool = require('../db');
const { encrypt, decrypt } = require('../util/crypto');
const {
  META_API_VERSION,
  MetaGraphApiError,
  redactSecrets,
  graphRequest,
} = require('./metaGraphClient');

const CONNECTION_STATES = Object.freeze({
  PENDING: 'PENDING',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  ERROR: 'ERROR',
  DISCONNECTED: 'DISCONNECTED',
});

const HEALTH_STATES = Object.freeze({
  HEALTHY: 'healthy',
  INVALID_TOKEN: 'invalid_token',
  RATE_LIMITED: 'rate_limited',
  UNKNOWN_ERROR: 'unknown_error',
  NOT_CHECKED: 'unknown',
});

class ProvisioningError extends Error {
  constructor(message, status = 400, code = 'provisioning_error', details = {}) {
    super(redactSecrets(message));
    this.name = 'ProvisioningError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Normalises phone numbers for matching: strip non-digits.
 */
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

/**
 * Exchanges OAuth authorization code for permanent access token.
 */
async function exchangeOAuthCode(code) {
  if (!code || typeof code !== 'string') {
    throw new ProvisioningError('Authorization code is required', 400, 'missing_code');
  }

  const appId = process.env.META_APP_ID || 'test-app-id';
  const appSecret = process.env.META_APP_SECRET || 'test-app-secret';

  if ((!process.env.META_APP_ID || !process.env.META_APP_SECRET) && process.env.NODE_ENV === 'production') {
    throw new ProvisioningError('Meta App ID and Secret are not configured on server', 503, 'meta_unconfigured');
  }

  try {
    const res = await graphRequest({
      method: 'GET',
      path: 'oauth/access_token',
      params: {
        client_id: appId,
        client_secret: appSecret,
        code: code.trim(),
      },
    });

    if (!res || !res.access_token) {
      throw new ProvisioningError('No access token returned from Meta code exchange', 400, 'exchange_failed');
    }
    return res.access_token;
  } catch (err) {
    if (err instanceof MetaGraphApiError) {
      throw new ProvisioningError(`Meta code exchange failed: ${err.message}`, err.status, err.code);
    }
    throw err;
  }
}

/**
 * Fetches WABA details (business information).
 */
async function getWabaDetails({ wabaId, accessToken }) {
  if (!wabaId) return null;
  try {
    const data = await graphRequest({
      method: 'GET',
      path: encodeURIComponent(wabaId),
      accessToken,
      params: {
        fields: 'id,name,currency,timezone_id,message_template_namespace',
      },
    });
    return data;
  } catch (err) {
    console.warn(`[whatsapp:provisioning] WABA discovery warning for ${wabaId}:`, err.message);
    return null;
  }
}

/**
 * Fetches phone numbers under a WABA.
 */
async function getWabaPhoneNumbers({ wabaId, accessToken }) {
  if (!wabaId) return [];
  try {
    const data = await graphRequest({
      method: 'GET',
      path: `${encodeURIComponent(wabaId)}/phone_numbers`,
      accessToken,
      params: {
        fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,status',
      },
    });
    return Array.isArray(data?.data) ? data.data : [];
  } catch (err) {
    console.warn(`[whatsapp:provisioning] Phone discovery warning for WABA ${wabaId}:`, err.message);
    return [];
  }
}

/**
 * Fetches individual phone number metadata.
 */
async function getPhoneNumberMeta({ phoneNumberId, accessToken }) {
  if (!phoneNumberId) return null;
  try {
    const data = await graphRequest({
      method: 'GET',
      path: encodeURIComponent(phoneNumberId),
      accessToken,
      params: {
        fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,status',
      },
    });
    return data;
  } catch (err) {
    console.warn(`[whatsapp:provisioning] Phone metadata warning for ${phoneNumberId}:`, err.message);
    return null;
  }
}

/**
 * Required phone registration for WhatsApp Cloud API messaging.
 */
async function registerPhoneNumber({ phoneNumberId, accessToken, pin = '000000' }) {
  if (!phoneNumberId) return { registered: false };
  try {
    const res = await graphRequest({
      method: 'POST',
      path: `${encodeURIComponent(phoneNumberId)}/register`,
      accessToken,
      body: {
        messaging_product: 'whatsapp',
        pin: String(pin),
      },
    });
    return { registered: Boolean(res?.success) };
  } catch (err) {
    // If the number is already registered or does not require PIN re-registration, log and proceed
    console.info(`[whatsapp:provisioning] Phone registration note for ${phoneNumberId}:`, err.message);
    return { registered: false, note: err.message };
  }
}

/**
 * Subscribes a WABA to the Green Pilot application webhook.
 */
async function subscribeWabaWebhook({ wabaId, accessToken }) {
  if (!wabaId) return { success: false };
  try {
    const res = await graphRequest({
      method: 'POST',
      path: `${encodeURIComponent(wabaId)}/subscribed_apps`,
      accessToken,
    });
    return { success: Boolean(res?.success) };
  } catch (err) {
    console.warn(`[whatsapp:provisioning] Webhook subscription failed for WABA ${wabaId}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Verifies that the WABA has an active webhook subscription.
 */
async function verifyWabaWebhookSubscription({ wabaId, accessToken }) {
  if (!wabaId) return { subscribed: false };
  try {
    const data = await graphRequest({
      method: 'GET',
      path: `${encodeURIComponent(wabaId)}/subscribed_apps`,
      accessToken,
    });
    const apps = Array.isArray(data?.data) ? data.data : [];
    const subscribed = apps.length > 0;
    return { subscribed, apps };
  } catch (err) {
    console.warn(`[whatsapp:provisioning] Webhook verification warning for WABA ${wabaId}:`, err.message);
    return { subscribed: false, error: err.message };
  }
}

/**
 * Provisions a WhatsApp connection after Embedded Signup or manual connection.
 * Idempotent: repeated provisioning updates existing phone connection instead of duplicating rows.
 */
async function provisionWhatsAppAccount({
  organizationId,
  code,
  directAccessToken,
  wabaId,
  phoneNumberId,
  businessId = null,
  displayName = null,
  displayPhoneNumber = null,
  verifyToken = null,
  db = pool,
}) {
  if (!organizationId) {
    throw new ProvisioningError('Organization context is required for provisioning', 400, 'missing_organization');
  }

  // 1. Resolve Access Token
  let accessToken = directAccessToken;
  if (!accessToken && code) {
    accessToken = await exchangeOAuthCode(code);
  }
  if (!accessToken) {
    throw new ProvisioningError('Access token or authorization code is required', 400, 'missing_credentials');
  }

  // 2. Discover / Verify WABA
  let resolvedWabaId = wabaId ? String(wabaId).trim() : null;
  let wabaMeta = null;
  if (resolvedWabaId) {
    wabaMeta = await getWabaDetails({ wabaId: resolvedWabaId, accessToken });
  }

  // 3. Discover / Verify Phone Number
  let resolvedPhoneId = phoneNumberId ? String(phoneNumberId).trim() : null;
  let resolvedDisplayName = displayName;
  let resolvedDisplayPhone = displayPhoneNumber;
  let phoneMeta = null;

  if (resolvedWabaId && !resolvedPhoneId) {
    const phones = await getWabaPhoneNumbers({ wabaId: resolvedWabaId, accessToken });
    if (phones.length > 0) {
      resolvedPhoneId = phones[0].id;
      resolvedDisplayName = resolvedDisplayName || phones[0].verified_name;
      resolvedDisplayPhone = resolvedDisplayPhone || phones[0].display_phone_number;
      phoneMeta = phones[0];
    }
  }

  if (resolvedPhoneId && (!resolvedDisplayName || !resolvedDisplayPhone || !phoneMeta)) {
    phoneMeta = await getPhoneNumberMeta({ phoneNumberId: resolvedPhoneId, accessToken });
    if (phoneMeta) {
      resolvedDisplayName = resolvedDisplayName || phoneMeta.verified_name;
      resolvedDisplayPhone = resolvedDisplayPhone || phoneMeta.display_phone_number;
    }
  }

  if (!resolvedPhoneId) {
    throw new ProvisioningError('No phone number could be identified for this WhatsApp account', 400, 'no_phone_number');
  }

  // Normalize display values
  const cleanPhone = normalizePhone(resolvedDisplayPhone);
  const finalDisplayName = resolvedDisplayName || `WhatsApp ${resolvedPhoneId}`;

  // 4. Attempt Required Phone Registration
  const regResult = await registerPhoneNumber({ phoneNumberId: resolvedPhoneId, accessToken });

  // 5. Complete WABA Webhook Subscription
  let webhookSubscribed = false;
  let webhookError = null;
  if (resolvedWabaId) {
    const subRes = await subscribeWabaWebhook({ wabaId: resolvedWabaId, accessToken });
    if (subRes.success) {
      const verifyRes = await verifyWabaWebhookSubscription({ wabaId: resolvedWabaId, accessToken });
      webhookSubscribed = verifyRes.subscribed;
      if (!webhookSubscribed) {
        webhookError = 'Webhook subscription succeeded but could not be verified by Meta';
      }
    } else {
      webhookError = subRes.error || 'Failed to subscribe WABA to application webhook';
    }
  }

  // 6. Determine Explicit Connection State
  // CRITICAL REQUIREMENT: Do not tell the customer "Connected" if webhook provisioning failed!
  let connectionStatus = CONNECTION_STATES.CONNECTED;
  let healthStatus = HEALTH_STATES.HEALTHY;
  let errorMessage = null;

  if (webhookError) {
    connectionStatus = CONNECTION_STATES.ERROR;
    healthStatus = HEALTH_STATES.UNKNOWN_ERROR;
    errorMessage = webhookError;
  }

  // 7. Securely Persist in coexistence.whatsapp_accounts
  const encryptedToken = encrypt(accessToken.trim());
  const encryptedVerify = verifyToken ? encrypt(verifyToken.trim()) : null;
  const metaAppId = process.env.META_APP_ID || null;
  const metadata = {
    businessId: businessId || null,
    wabaName: wabaMeta?.name || null,
    wabaTimezone: wabaMeta?.timezone_id || null,
    qualityRating: phoneMeta?.quality_rating || 'UNKNOWN',
    codeVerificationStatus: phoneMeta?.code_verification_status || 'UNKNOWN',
    webhookSubscribed,
    registrationAttempted: true,
    lastProvisionedAt: new Date().toISOString(),
  };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Check if there is an existing account for this phone number
    const { rows: existingRows } = await client.query(
      `SELECT * FROM coexistence.whatsapp_accounts WHERE phone_number_id = $1`,
      [resolvedPhoneId]
    );

    let savedAccount = null;

    if (existingRows.length > 0) {
      const ex = existingRows[0];
      // If belongs to another org, prevent hijacking
      if (ex.organization_id && ex.organization_id !== organizationId) {
        await client.query('ROLLBACK');
        throw new ProvisioningError('This WhatsApp phone number is already connected to another organization', 409, 'phone_conflict');
      }

      const { rows } = await client.query(
        `UPDATE coexistence.whatsapp_accounts
            SET display_name = $1,
                display_phone_number = $2,
                waba_id = $3,
                access_token_encrypted = $4,
                verify_token_encrypted = COALESCE($5, verify_token_encrypted),
                meta_app_id = COALESCE($6, meta_app_id),
                is_active = $7,
                connection_status = $8,
                health_status = $9,
                last_error_message = $10::text,
                last_error_at = CASE WHEN $10::text IS NOT NULL THEN NOW() ELSE last_error_at END,
                last_success_at = CASE WHEN $8 = 'CONNECTED' THEN NOW() ELSE last_success_at END,
                business_id = COALESCE($11, business_id),
                metadata = $12,
                webhook_subscribed = $13,
                webhook_verified_at = CASE WHEN $13 THEN NOW() ELSE webhook_verified_at END,
                registered_at = CASE WHEN $14 THEN NOW() ELSE registered_at END,
                disconnected_at = NULL,
                updated_at = NOW()
          WHERE id = $15
          RETURNING *`,
        [
          finalDisplayName,
          cleanPhone,
          resolvedWabaId,
          encryptedToken,
          encryptedVerify,
          metaAppId,
          connectionStatus === CONNECTION_STATES.CONNECTED,
          connectionStatus,
          healthStatus,
          errorMessage,
          businessId,
          metadata,
          webhookSubscribed,
          regResult.registered,
          ex.id,
        ]
      );
      savedAccount = rows[0];
    } else {
      // Determine default
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM coexistence.whatsapp_accounts WHERE organization_id = $1`,
        [organizationId]
      );
      const isDefault = countRows[0].n === 0;

      const { rows } = await client.query(
        `INSERT INTO coexistence.whatsapp_accounts
           (organization_id, display_name, display_phone_number, phone_number_id, waba_id,
            access_token_encrypted, verify_token_encrypted, meta_app_id, is_default, is_active,
            connection_status, health_status, last_error_message, last_success_at,
            business_id, metadata, webhook_subscribed, webhook_verified_at, registered_at,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text,CASE WHEN $11 = 'CONNECTED' THEN NOW() ELSE NULL END,$14,$15,$16,CASE WHEN $16 THEN NOW() ELSE NULL END,CASE WHEN $17 THEN NOW() ELSE NULL END,NOW(),NOW())
         RETURNING *`,
        [
          organizationId,
          finalDisplayName,
          cleanPhone,
          resolvedPhoneId,
          resolvedWabaId,
          encryptedToken,
          encryptedVerify,
          metaAppId,
          isDefault,
          connectionStatus === CONNECTION_STATES.CONNECTED,
          connectionStatus,
          healthStatus,
          errorMessage,
          businessId,
          metadata,
          webhookSubscribed,
          regResult.registered,
        ]
      );
      savedAccount = rows[0];
    }

    await client.query('COMMIT');
    return savedAccount;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verifies a WhatsApp connection without exposing credentials.
 */
async function verifyConnectionHealth({ accountId, organizationId, db = pool }) {
  if (!accountId || !organizationId) {
    throw new ProvisioningError('Account ID and organization context required', 400, 'missing_context');
  }

  // Scoped to organizationId to enforce tenant boundary
  const { rows } = await db.query(
    `SELECT * FROM coexistence.whatsapp_accounts
      WHERE id = $1 AND organization_id = $2`,
    [accountId, organizationId]
  );

  if (rows.length === 0) {
    throw new ProvisioningError('WhatsApp account not found', 404, 'not_found');
  }

  const account = rows[0];
  let accessToken;
  try {
    accessToken = decrypt(account.access_token_encrypted);
  } catch (err) {
    await db.query(
      `UPDATE coexistence.whatsapp_accounts
          SET health_status = 'unknown_error',
              last_error_at = NOW(),
              last_error_message = 'Failed to decrypt access token'
        WHERE id = $1`,
      [account.id]
    );
    return {
      healthy: false,
      connectionStatus: CONNECTION_STATES.ERROR,
      healthStatus: HEALTH_STATES.UNKNOWN_ERROR,
      error: 'Stored access token could not be decrypted',
    };
  }

  let healthStatus = HEALTH_STATES.HEALTHY;
  let connectionStatus = account.is_active ? CONNECTION_STATES.CONNECTED : CONNECTION_STATES.DISCONNECTED;
  let errorMsg = null;
  let phoneMeta = null;
  let webhookSubscribed = account.webhook_subscribed;

  try {
    // 1. Check phone number with Meta
    phoneMeta = await getPhoneNumberMeta({
      phoneNumberId: account.phone_number_id,
      accessToken,
    });

    if (!phoneMeta) {
      healthStatus = HEALTH_STATES.UNKNOWN_ERROR;
      connectionStatus = CONNECTION_STATES.ERROR;
      errorMsg = 'Could not verify phone number with Meta Graph API';
    }

    // 2. Check WABA webhook subscription
    if (account.waba_id) {
      const vRes = await verifyWabaWebhookSubscription({
        wabaId: account.waba_id,
        accessToken,
      });
      webhookSubscribed = vRes.subscribed;
      if (!webhookSubscribed) {
        healthStatus = HEALTH_STATES.UNKNOWN_ERROR;
        connectionStatus = CONNECTION_STATES.ERROR;
        errorMsg = 'WABA webhook subscription is inactive or missing';
      }
    }
  } catch (err) {
    connectionStatus = CONNECTION_STATES.ERROR;
    errorMsg = redactSecrets(err.message);
    if (err instanceof MetaGraphApiError) {
      if (err.code === 'invalid_token') healthStatus = HEALTH_STATES.INVALID_TOKEN;
      else if (err.code === 'rate_limited') healthStatus = HEALTH_STATES.RATE_LIMITED;
      else healthStatus = HEALTH_STATES.UNKNOWN_ERROR;
    } else {
      healthStatus = HEALTH_STATES.UNKNOWN_ERROR;
    }
  }

  // Update account in DB
  const isHealthy = healthStatus === HEALTH_STATES.HEALTHY && connectionStatus === CONNECTION_STATES.CONNECTED;
  await db.query(
    `UPDATE coexistence.whatsapp_accounts
        SET health_status = $1,
            connection_status = $2,
            webhook_subscribed = $3,
            last_error_message = $4::text,
            last_error_at = CASE WHEN $4::text IS NOT NULL THEN NOW() ELSE last_error_at END,
            last_success_at = CASE WHEN $5 THEN NOW() ELSE last_success_at END,
            updated_at = NOW()
      WHERE id = $6`,
    [healthStatus, connectionStatus, webhookSubscribed, errorMsg, isHealthy, account.id]
  );

  return {
    accountId: account.id,
    healthy: isHealthy,
    connectionStatus,
    healthStatus,
    webhookSubscribed,
    displayName: phoneMeta?.verified_name || account.display_name,
    displayPhoneNumber: phoneMeta?.display_phone_number || account.display_phone_number,
    qualityRating: phoneMeta?.quality_rating || account.metadata?.qualityRating || 'UNKNOWN',
    lastError: errorMsg,
  };
}

/**
 * Safely disconnects a WhatsApp account without deleting CRM contacts, chats, or leads.
 */
async function disconnectWhatsAppAccount({ accountId, organizationId, db = pool }) {
  if (!accountId || !organizationId) {
    throw new ProvisioningError('Account ID and organization context required for disconnect', 400, 'missing_context');
  }

  const { rows } = await db.query(
    `UPDATE coexistence.whatsapp_accounts
        SET is_active = FALSE,
            connection_status = $1,
            disconnected_at = NOW(),
            updated_at = NOW()
      WHERE id = $2 AND organization_id = $3
      RETURNING *`,
    [CONNECTION_STATES.DISCONNECTED, accountId, organizationId]
  );

  if (rows.length === 0) {
    throw new ProvisioningError('WhatsApp account not found or access denied', 404, 'not_found');
  }

  return rows[0];
}

module.exports = {
  CONNECTION_STATES,
  HEALTH_STATES,
  ProvisioningError,
  normalizePhone,
  exchangeOAuthCode,
  getWabaDetails,
  getWabaPhoneNumbers,
  getPhoneNumberMeta,
  registerPhoneNumber,
  subscribeWabaWebhook,
  verifyWabaWebhookSubscription,
  provisionWhatsAppAccount,
  verifyConnectionHealth,
  disconnectWhatsAppAccount,
};
