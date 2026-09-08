// Dedicated WhatsApp outbound messaging service (Phase 5).
// Handles:
// 1. Organization WhatsApp connection resolution & AES-256-GCM credential decryption
// 2. Optimistic persistence in coexistence.chat_history (status='sending')
// 3. Conversation resolution & activity timestamp update
// 4. Meta Cloud API invocation (text, media, template, interactive, location)
// 5. WhatsApp message ID (wamid) persistence and status updates (sent / failed)
// 6. Organization-scoped real-time event emissions (emitter.js)

const crypto = require('crypto');
const pool = require('../db');
const { decrypt } = require('../util/crypto');
const metaSend = require('../integrations/metaSend');
const emitter = require('../realtime/emitter');

function localMessageId() {
  return `local-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

// Test hook for mocking Meta Cloud API calls in automated tests
let testMetaClient = null;

function setTestMetaClient(client) {
  testMetaClient = client;
}

function resetTestMetaClient() {
  testMetaClient = null;
}

/**
 * Resolve active WhatsApp account for an organization with decrypted credentials.
 * Strict tenant boundary: only returns an account owned by organizationId.
 */
async function resolveOrgAccount({ organizationId, fromPhoneNumber, accountId, db = pool }) {
  if (!organizationId) {
    return { error: 'organizationId is required', status: 400 };
  }

  const params = [organizationId];
  let filter = '';

  if (accountId) {
    params.push(accountId);
    filter += ` AND id = $${params.length}`;
  }

  if (fromPhoneNumber) {
    const norm = normalizePhone(fromPhoneNumber);
    if (norm) {
      params.push(norm);
      params.push(String(fromPhoneNumber));
      filter += ` AND (regexp_replace(display_phone_number, '\\D', '', 'g') = $${params.length - 1} OR phone_number_id = $${params.length})`;
    }
  }

  const { rows } = await db.query(
    `SELECT * FROM coexistence.whatsapp_accounts
     WHERE organization_id = $1
       AND is_active = TRUE
       ${filter}
     ORDER BY is_default DESC, id ASC
     LIMIT 1`,
    params
  );

  if (!rows[0]) {
    return {
      error: `No active WhatsApp connection found for organization ${organizationId}${fromPhoneNumber ? ` with phone ${fromPhoneNumber}` : ''}`,
      status: 404,
      code: 'whatsapp-account-not-found',
    };
  }

  const r = rows[0];
  let accessToken = null;
  try {
    accessToken = decrypt(r.access_token_encrypted);
  } catch (decErr) {
    return {
      error: `Failed to decrypt access token for account ${r.id}: ${decErr.message}`,
      status: 500,
      code: 'credential-decryption-failed',
    };
  }

  if (!accessToken) {
    return {
      error: 'WhatsApp connection access token is empty',
      status: 400,
      code: 'missing-access-token',
    };
  }

  return {
    account: {
      id: r.id,
      organizationId: r.organization_id,
      displayName: r.display_name,
      displayPhoneNumber: r.display_phone_number,
      phoneNumberId: r.phone_number_id,
      wabaId: r.waba_id,
      accessToken,
      isActive: r.is_active,
    },
  };
}

/**
 * Send an outbound WhatsApp message.
 *
 * @param {Object} options
 * @param {string} options.organizationId - Authoritative organization ID
 * @param {string} [options.fromNumber] - Optional sender phone or phone_number_id
 * @param {string} [options.accountId] - Optional WhatsApp account ID
 * @param {string} options.toNumber - Recipient phone number (digits)
 * @param {string} [options.type='text'] - Message type ('text'|'template'|'media'|'image'|'document'|'audio'|'video'|'location')
 * @param {string} [options.text] - Message text content
 * @param {Object} [options.media] - Media payload { type, mediaId, link, caption, filename }
 * @param {Object} [options.template] - Template payload { name, languageCode, components }
 * @param {Object} [options.location] - Location payload { latitude, longitude, name, address }
 * @param {string} [options.contextMessageId] - WhatsApp message ID being replied to
 * @param {any} [options.db] - DB client (pool or transaction)
 */
async function sendWhatsAppMessage({
  organizationId,
  fromNumber,
  accountId,
  toNumber,
  to,
  type = 'text',
  text,
  media,
  template,
  location,
  contextMessageId,
  db = pool,
}) {
  if (!organizationId) throw new Error('sendWhatsAppMessage: organizationId is required');
  const recipient = toNumber || to;
  if (!recipient) throw new Error('sendWhatsAppMessage: toNumber is required');

  const normTo = normalizePhone(recipient);
  if (!normTo || normTo.length < 7) {
    const err = new Error('Invalid recipient phone number');
    err.status = 400;
    err.code = 'invalid-phone-number';
    throw err;
  }

  // 1. Resolve organization's WhatsApp account
  const { account, error, status, code } = await resolveOrgAccount({
    organizationId,
    fromPhoneNumber: fromNumber,
    accountId,
    db,
  });

  if (error) {
    const err = new Error(error);
    err.status = status || 400;
    err.code = code || 'account-resolution-failed';
    throw err;
  }

  const senderNumber = normalizePhone(account.displayPhoneNumber || fromNumber);
  const localId = localMessageId();
  const normalizedType = (type === 'image' || type === 'video' || type === 'audio' || type === 'document')
    ? type
    : (media ? (media.type || 'image') : (template ? 'template' : (location ? 'location' : 'text')));

  const messageBody = text || (media?.caption || media?.filename) || (template?.name) || (location?.name || 'Location') || '';

  // 2. Persist pending message in chat_history
  await db.query(
    `INSERT INTO coexistence.chat_history
       (message_id, phone_number_id, wa_number, contact_number, to_number,
        direction, message_type, message_body, raw_payload,
        media_url, media_mime_type, status, timestamp, template_meta, context_message_id,
        organization_id)
     VALUES ($1, $2, $3, $4, $5, 'outgoing', $6, $7, $8, $9, $10, 'sending', NOW(), $11, $12, $13)`,
    [
      localId,
      account.phoneNumberId,
      senderNumber,
      normTo,
      normTo,
      normalizedType,
      messageBody || null,
      JSON.stringify({ origin: 'outbound', queued_at: new Date().toISOString() }),
      media?.link || media?.mediaId || null,
      media?.mimeType || null,
      template ? JSON.stringify(template) : null,
      contextMessageId || null,
      organizationId,
    ]
  );

  // 3. Upsert conversation record
  await db.query(
    `INSERT INTO coexistence.conversations
       (organization_id, whatsapp_account_id, wa_number, contact_number, last_message_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (organization_id, whatsapp_account_id, contact_number)
     DO UPDATE SET
       last_message_at = NOW(),
       updated_at = NOW()`,
    [organizationId, account.id, senderNumber, normTo]
  ).catch(() => {});

  // 4. Emit optimistic realtime updates
  try {
    emitter.emitConversationUpdated(organizationId, {
      waNumber: senderNumber,
      contactNumber: normTo,
      lastMessagePreview: String(messageBody).slice(0, 280),
      lastMessageAt: new Date().toISOString(),
    });

    emitter.emitInboundMessage(organizationId, {
      message_id: localId,
      wa_number: senderNumber,
      contact_number: normTo,
      direction: 'outgoing',
      message_type: normalizedType,
      message_body: messageBody,
      status: 'sending',
      timestamp: new Date().toISOString(),
      context_message_id: contextMessageId || null,
    });
  } catch (emitErr) {
    console.warn('[whatsappMessaging] optimistic emit warning:', emitErr.message);
  }

  // 5. Call Meta Cloud API
  let metaResult;
  try {
    if (testMetaClient) {
      metaResult = await testMetaClient({
        account,
        toNumber: normTo,
        type: normalizedType,
        text,
        media,
        template,
        location,
        contextMessageId,
      });
    } else {
      const baseArgs = {
        accessToken: account.accessToken,
        phoneNumberId: account.phoneNumberId,
        to: normTo,
      };

      if (normalizedType === 'text') {
        metaResult = await metaSend.sendText({
          ...baseArgs,
          body: String(text || '').trim(),
          contextMessageId: contextMessageId || null,
        });
      } else if (normalizedType === 'template') {
        metaResult = await metaSend.sendTemplate({
          ...baseArgs,
          templateName: template.name,
          languageCode: template.languageCode || 'en',
          components: template.components || [],
        });
      } else if (['image', 'video', 'audio', 'document'].includes(normalizedType)) {
        metaResult = await metaSend.sendMedia({
          ...baseArgs,
          type: normalizedType,
          mediaId: media?.mediaId,
          link: media?.link,
          caption: media?.caption,
          filename: media?.filename,
          contextMessageId: contextMessageId || null,
        });
      } else if (normalizedType === 'location') {
        metaResult = await metaSend.sendLocation({
          ...baseArgs,
          latitude: location.latitude,
          longitude: location.longitude,
          name: location.name,
          address: location.address,
        });
      } else {
        metaResult = await metaSend.sendText({
          ...baseArgs,
          body: String(text || messageBody || '').trim(),
          contextMessageId: contextMessageId || null,
        });
      }
    }
  } catch (sendErr) {
    // 6a. Handle Meta Error
    const errMsg = sendErr.message || 'Meta Cloud API call failed';
    console.error('[whatsappMessaging] outbound Meta error:', errMsg);

    await db.query(
      `UPDATE coexistence.chat_history
       SET status = 'failed', error_message = $1
       WHERE message_id = $2`,
      [errMsg.slice(0, 500), localId]
    ).catch(() => {});

    try {
      emitter.emitMessageStatus(organizationId, {
        messageId: localId,
        waNumber: senderNumber,
        contactNumber: normTo,
        status: 'failed',
      });
    } catch { /* best effort */ }

    const err = new Error(errMsg);
    err.status = sendErr.status || 400;
    err.code = sendErr.metaError?.code || 'meta-api-error';
    err.localId = localId;
    throw err;
  }

  // 6b. Handle Meta Success
  const wamid = metaResult?.messages?.[0]?.id || `wamid.${localId}`;

  await db.query(
    `UPDATE coexistence.chat_history
     SET message_id = $1, status = 'sent', error_message = NULL
     WHERE message_id = $2`,
    [wamid, localId]
  ).catch(async (updateErr) => {
    // If conflict on message_id, keep row with wamid in raw_payload
    console.warn('[whatsappMessaging] update chat_history warning:', updateErr.message);
  });

  try {
    emitter.emitMessageStatus(organizationId, {
      messageId: wamid,
      waNumber: senderNumber,
      contactNumber: normTo,
      status: 'sent',
    });
  } catch { /* best effort */ }

  return {
    ok: true,
    messageId: wamid,
    localId,
    status: 'sent',
    waNumber: senderNumber,
    contactNumber: normTo,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  resolveOrgAccount,
  sendWhatsAppMessage,
  setTestMetaClient,
  resetTestMetaClient,
  localMessageId,
};
