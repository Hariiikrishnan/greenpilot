// Green Pilot — Phase 4/6: Dedicated WhatsApp Webhook Ingestion Service
//
// Handles:
// 1. GET verification (hub.mode, hub.verify_token, hub.challenge)
// 2. POST HMAC-SHA256 signature validation over raw request body
// 3. Authoritative tenant & WhatsApp account resolution from Meta business assets
// 4. Inbound message ingestion (text, media, interactive, reactions)
// 5. Contact / Lead resolution and creation
// 6. Conversation resolution and creation
// 7. Deduplication of incoming messages using Meta wamid as idempotency key
// 8. Monotonic status event progression (sent -> delivered -> read, or failed)
// 9. Organization-scoped realtime socket event emission
// 10. AI pipeline dispatch — routes inbound messages to active agent queue (Phase 6)

const crypto = require('crypto');
const pool = require('../db');
const { decrypt } = require('../util/crypto');
const { safeEqual, verifyMetaSignature } = require('../util/webhookSignature');
const {
  emitInboundMessage,
  emitMessageStatus,
  emitConversationUpdated,
  emitUnreadCountUpdate,
  emitCrmEvent,
} = require('../realtime/emitter');
// Phase 6: AI agent routing — lazy-required to avoid circular dependency at
// module load time (agentRouter -> agentQueue -> ...). Safe: first inbound
// message always arrives well after boot initializes all modules.
function getAgentRouter() {
  try { return require('./agentRouter'); } catch { return null; }
}

// Monotonic ordering of a message's delivery lifecycle.
// Status receipts are delivered at-least-once and can arrive out of order.
// Status must only ever ADVANCE — never downgrade a read blue double-tick back to delivered.
const STATUS_RANK = {
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  played: 3,
  failed: 2,
};

const SUPPORTED_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker']);

/**
 * Normalizes phone numbers to digits only — strips '+', spaces, dashes.
 */
function normalizePhone(s) {
  if (!s) return '';
  return String(s).replace(/\D/g, '');
}

/**
 * Pick primary phone number ID from Meta payload
 */
function pickPhoneNumberId(body) {
  return (
    body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ||
    body?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]?.recipient_id ||
    null
  );
}

/**
 * Pick WABA ID from Meta payload
 */
function pickWabaId(body) {
  return body?.entry?.[0]?.id || null;
}

/**
 * Invalidate / verify GET subscription
 */
async function verifyWebhookSubscription({ mode, verifyToken, challenge, expectedOrgId, db = pool }) {
  if (mode !== 'subscribe' || !verifyToken) {
    return { ok: false, status: 403, error: 'Verification failed: invalid mode or missing token' };
  }

  if (expectedOrgId) {
    const { rows: orgRows } = await db.query(
      'SELECT id FROM coexistence.organizations WHERE id = $1',
      [expectedOrgId]
    );
    if (!orgRows[0]) {
      return { ok: false, status: 403, error: 'Verification failed: unknown organization' };
    }
  }

  // 1. Check globally configured verify token
  if (process.env.META_WEBHOOK_VERIFY_TOKEN && safeEqual(process.env.META_WEBHOOK_VERIFY_TOKEN, verifyToken)) {
    return { ok: true, challenge: String(challenge ?? '') };
  }

  // 2. Check encrypted tokens on registered whatsapp_accounts
  try {
    const { rows } = await db.query(
      `SELECT verify_token_encrypted FROM coexistence.whatsapp_accounts
        WHERE verify_token_encrypted IS NOT NULL
          AND ($1::uuid IS NULL OR organization_id IS NULL OR organization_id = $1)`,
      [expectedOrgId || null]
    );
    for (const r of rows) {
      if (safeEqual(decrypt(r.verify_token_encrypted), verifyToken)) {
        return { ok: true, challenge: String(challenge ?? '') };
      }
    }
  } catch (err) {
    console.error('[webhook:verify] token lookup error:', err.message);
  }

  return { ok: false, status: 403, error: 'Verification failed: token mismatch' };
}

/**
 * Resolves authoritative WhatsApp account and organization from Meta assets.
 * Never trusts client-supplied organization IDs.
 */
async function resolveAccountFromAsset({ phoneNumberId, wabaId, db = pool }) {
  if (phoneNumberId) {
    const { rows } = await db.query(
      `SELECT id, organization_id, phone_number_id, waba_id, display_phone_number, is_default, connection_status
         FROM coexistence.whatsapp_accounts
        WHERE phone_number_id = $1
        ORDER BY is_default DESC, created_at DESC
        LIMIT 1`,
      [String(phoneNumberId)]
    );
    if (rows[0]) {
      return {
        accountId: rows[0].id,
        organizationId: rows[0].organization_id || null,
        phoneNumberId: rows[0].phone_number_id,
        wabaId: rows[0].waba_id,
        displayPhoneNumber: rows[0].display_phone_number,
        isDefault: rows[0].is_default,
        connectionStatus: rows[0].connection_status,
      };
    }
  }

  if (wabaId) {
    const { rows } = await db.query(
      `SELECT id, organization_id, phone_number_id, waba_id, display_phone_number, is_default, connection_status
         FROM coexistence.whatsapp_accounts
        WHERE waba_id = $1
        ORDER BY is_default DESC, created_at DESC
        LIMIT 1`,
      [String(wabaId)]
    );
    if (rows[0]) {
      return {
        accountId: rows[0].id,
        organizationId: rows[0].organization_id || null,
        phoneNumberId: rows[0].phone_number_id,
        wabaId: rows[0].waba_id,
        displayPhoneNumber: rows[0].display_phone_number,
        isDefault: rows[0].is_default,
        connectionStatus: rows[0].connection_status,
      };
    }
  }

  return null;
}

/**
 * Parses a Meta WhatsApp Cloud API webhook payload into normalized records.
 */
function parseMetaWebhookPayload(body) {
  const records = [];
  if (!body || body.object !== 'whatsapp_business_account') {
    return records;
  }

  const entries = Array.isArray(body.entry) ? body.entry : [];
  for (const entry of entries) {
    const wabaId = entry.id || null;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change.value || {};
      if (value.messaging_product !== 'whatsapp') continue;

      const metadata = value.metadata || {};
      const phoneNumberId = metadata.phone_number_id || '';
      const displayPhoneNumber = metadata.display_phone_number || '';

      // Contact profile mapping
      const contactProfiles = {};
      (value.contacts || []).forEach((c) => {
        const waId = c.wa_id || '';
        const name = c.profile?.name || '';
        if (waId && name) contactProfiles[waId] = name;
      });

      function parseSingleMessage(msg, direction, waNum, contactNum) {
        const record = {
          waba_id: wabaId,
          message_id: msg.id || '',
          phone_number_id: phoneNumberId,
          wa_number: normalizePhone(waNum || displayPhoneNumber),
          contact_number: normalizePhone(contactNum || ''),
          to_number: normalizePhone(msg.to || ''),
          direction,
          message_type: msg.type || 'unknown',
          message_body: null,
          raw_payload: JSON.stringify(body),
          media_url: null,
          media_mime_type: null,
          media_filename: null,
          status: direction === 'incoming' ? 'received' : 'sent',
          timestamp: msg.timestamp
            ? new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
            : new Date().toISOString(),
          contact_name: contactProfiles[contactNum] || null,
          context_message_id: msg.context?.id || null,
        };

        const type = msg.type;
        if (type === 'text' && msg.text) {
          record.message_body = msg.text.body || '';
        } else if (type === 'image' && msg.image) {
          record.message_body = msg.image.caption || '';
          record.media_mime_type = msg.image.mime_type || null;
          record.media_url = msg.image.id || null;
        } else if (type === 'video' && msg.video) {
          record.message_body = msg.video.caption || '';
          record.media_mime_type = msg.video.mime_type || null;
          record.media_url = msg.video.id || null;
        } else if (type === 'audio' && msg.audio) {
          record.message_body = 'Audio message';
          record.media_mime_type = msg.audio.mime_type || null;
          record.media_url = msg.audio.id || null;
        } else if (type === 'voice' && msg.voice) {
          record.message_body = 'Voice message';
          record.media_mime_type = msg.voice.mime_type || null;
          record.media_url = msg.voice.id || null;
        } else if (type === 'document' && msg.document) {
          record.message_body = msg.document.filename || 'Document';
          record.media_mime_type = msg.document.mime_type || null;
          record.media_url = msg.document.id || null;
          record.media_filename = msg.document.filename || null;
        } else if (type === 'location' && msg.location) {
          const lat = msg.location.latitude || '';
          const lng = msg.location.longitude || '';
          record.message_body = `Location: ${lat}, ${lng}`;
        } else if (type === 'sticker' && msg.sticker) {
          record.message_body = 'Sticker';
          record.media_mime_type = msg.sticker.mime_type || null;
          record.media_url = msg.sticker.id || null;
        } else if (type === 'contacts' && msg.contacts) {
          const names = msg.contacts
            .map((c) => c.name?.formatted_name || c.name?.first_name || 'Contact')
            .join(', ');
          record.message_body = `Shared contact(s): ${names}`;
        } else if (type === 'interactive' && msg.interactive) {
          const reply = msg.interactive.button_reply || msg.interactive.list_reply || {};
          record.message_body = reply.title || 'Interactive response';
          record.message_type = 'interactive';
        } else if (type === 'reaction' && msg.reaction) {
          record.message_body = `Reaction: ${msg.reaction.emoji || ''}`;
          record.message_type = 'reaction';
          record.reaction = {
            targetMessageId: msg.reaction.message_id || null,
            emoji: msg.reaction.emoji || '',
            from: msg.from || null,
          };
        } else if (type === 'order' && msg.order) {
          record.message_body = 'Order received';
        } else if (type === 'system' && msg.system) {
          record.message_body = msg.system.body || 'System message';
        }

        return record;
      }

      // 1. Incoming messages
      const messages = value.messages || [];
      for (const msg of messages) {
        records.push(parseSingleMessage(msg, 'incoming', displayPhoneNumber, msg.from));
      }

      // 2. Outgoing message echoes (messages sent directly from Meta WhatsApp App)
      const echoes = value.message_echoes || [];
      for (const msg of echoes) {
        records.push(parseSingleMessage(msg, 'outgoing', displayPhoneNumber, msg.to));
      }

      // 3. Status updates (sent, delivered, read, failed)
      const statuses = value.statuses || [];
      for (const status of statuses) {
        records.push({
          waba_id: wabaId,
          message_id: status.id || '',
          phone_number_id: phoneNumberId,
          wa_number: normalizePhone(displayPhoneNumber),
          contact_number: normalizePhone(status.recipient_id || ''),
          to_number: normalizePhone(status.recipient_id || ''),
          direction: 'outgoing',
          message_type: 'status',
          message_body: `Status: ${status.status || ''}`,
          raw_payload: JSON.stringify(body),
          media_url: null,
          media_mime_type: null,
          media_filename: null,
          status: status.status || 'unknown',
          timestamp: status.timestamp
            ? new Date(parseInt(status.timestamp, 10) * 1000).toISOString()
            : new Date().toISOString(),
          contact_name: contactProfiles[status.recipient_id] || null,
          errors: status.errors || null,
          conversation: status.conversation || null,
        });
      }
    }
  }

  return records;
}

/**
 * Webhook audit logger
 */
async function auditWebhookReceived({ payload, headers, remoteIp, source = 'meta', db = pool }) {
  try {
    const pnId = pickPhoneNumberId(payload);
    const { rows } = await db.query(
      `INSERT INTO coexistence.webhook_events
         (source, remote_ip, request_headers, payload, payload_kind, meta_object, phone_number_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        source,
        remoteIp || null,
        JSON.stringify(headers || {}),
        JSON.stringify(payload || {}),
        'whatsapp_webhook',
        payload?.object || null,
        pnId,
      ]
    );
    return rows[0]?.id || null;
  } catch (err) {
    console.error('[webhook:audit] log error:', err.message);
    return null;
  }
}

async function auditWebhookProcessed(id, { status, recordsExtracted = 0, error = null, processingMs = null, db = pool }) {
  if (!id) return;
  try {
    await db.query(
      `UPDATE coexistence.webhook_events
          SET processing_status = $1, records_extracted = $2, processing_error = $3, processing_ms = $4
        WHERE id = $5`,
      [status, recordsExtracted, error ? String(error).slice(0, 500) : null, processingMs, id]
    );
  } catch (err) {
    console.error('[webhook:audit] update error:', err.message);
  }
}

/**
 * Core processing method for POST webhooks
 */
async function processWebhookEvent({
  rawBody,
  headers,
  payload,
  expectedOrgId = null,
  remoteIp = null,
  db = pool,
}) {
  const startTime = Date.now();
  const auditId = await auditWebhookReceived({ payload, headers, remoteIp, db });

  // 1. Validate payload presence
  if (!payload || typeof payload !== 'object') {
    await auditWebhookProcessed(auditId, {
      status: 'error',
      error: 'Empty or invalid JSON payload',
      processingMs: Date.now() - startTime,
      db,
    });
    return { ok: false, status: 400, error: 'Empty payload' };
  }

  // 2. Parse payload into normalized records
  const records = parseMetaWebhookPayload(payload);
  if (records.length === 0) {
    await auditWebhookProcessed(auditId, {
      status: 'processed',
      recordsExtracted: 0,
      processingMs: Date.now() - startTime,
      db,
    });
    return { ok: true, status: 200, stored: 0, duplicates: 0 };
  }

  // 3. Resolve accounts and organizations for all involved phone numbers / WABAs
  const acctCache = new Map();
  for (const r of records) {
    const key = `${r.phone_number_id || ''}:${r.waba_id || ''}`;
    if (!acctCache.has(key)) {
      const acct = await resolveAccountFromAsset({
        phoneNumberId: r.phone_number_id,
        wabaId: r.waba_id,
        db,
      });
      if (acct) acctCache.set(key, acct);
    }
  }

  // 4. Ingest records inside a transaction
  const client = await db.connect();
  let storedCount = 0;
  let duplicateCount = 0;
  const statusUpdates = [];
  const incomingEmits = [];

  try {
    await client.query('BEGIN');

    for (const r of records) {
      const key = `${r.phone_number_id || ''}:${r.waba_id || ''}`;
      const acct = acctCache.get(key);

      // Unknown asset: skip persistence
      if (!acct) {
        continue;
      }

      // Authoritative tenant resolution
      const authoritativeOrgId = acct.organizationId;

      // Cross-tenant protection: if expectedOrgId was specified in the route URL,
      // it MUST match the authoritative organization of the WhatsApp asset!
      if (expectedOrgId && authoritativeOrgId && expectedOrgId !== authoritativeOrgId) {
        console.warn(
          `[webhook:tenant-violation] Asset org (${authoritativeOrgId}) does not match expected org (${expectedOrgId})`
        );
        continue;
      }

      const orgId = expectedOrgId || authoritativeOrgId || null;

      // ── Status updates ───────────────────────────────────────────
      if (r.message_type === 'status') {
        let failedError = null;
        if (r.status === 'failed' && Array.isArray(r.errors) && r.errors.length > 0) {
          const e = r.errors[0] || {};
          const detail = e.error_data?.details || e.title || e.message || 'Message failed to send';
          failedError = (e.code != null ? `[${e.code}] ` : '') + detail;
        }

        const newRank = STATUS_RANK[r.status] ?? 0;
        const upd = await client.query(
          `UPDATE coexistence.chat_history
              SET status = $1,
                  error_message = CASE WHEN $1 = 'failed' AND $4::text IS NOT NULL
                                       THEN $4 ELSE error_message END
            WHERE message_id = $2
              AND ($5::uuid IS NULL OR organization_id IS NULL OR organization_id = $5)
              AND $3 > (CASE status
                          WHEN 'sending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2
                          WHEN 'read' THEN 3 WHEN 'played' THEN 3 WHEN 'failed' THEN 2 ELSE 0 END)
            RETURNING wa_number, contact_number, message_id`,
          [r.status, r.message_id, newRank, failedError, orgId]
        );

        if (upd.rowCount > 0) {
          storedCount++;
          const row = upd.rows[0];
          statusUpdates.push({
            orgId,
            messageId: row.message_id,
            status: r.status,
            waNumber: row.wa_number,
            contactNumber: row.contact_number,
            timestamp: r.timestamp,
          });
        }
        continue;
      }

      // ── Message reactions ─────────────────────────────────────────
      if (r.message_type === 'reaction') {
        const tgt = r.reaction?.targetMessageId;
        if (tgt) {
          if (r.reaction.emoji) {
            await client.query(
              `INSERT INTO coexistence.message_reactions
                 (wa_number, contact_number, target_message_id, direction, emoji, reactor, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,NOW())
               ON CONFLICT (target_message_id, direction)
               DO UPDATE SET emoji = EXCLUDED.emoji, reactor = EXCLUDED.reactor, updated_at = NOW()`,
              [r.wa_number, r.contact_number, tgt, r.direction, r.reaction.emoji, r.reaction.from || null]
            );
          } else {
            await client.query(
              `DELETE FROM coexistence.message_reactions WHERE target_message_id = $1 AND direction = $2`,
              [tgt, r.direction]
            );
          }
        }
        continue;
      }

      // ── Inbound / Outgoing message persistence with Deduplication ───
      // Uses PostgreSQL (xmax = 0) to distinguish INSERT from UPDATE
      const insertRes = await client.query(
        `INSERT INTO coexistence.chat_history
          (message_id, phone_number_id, wa_number, contact_number, to_number,
           direction, message_type, message_body, raw_payload, media_url,
           media_mime_type, media_filename, status, timestamp, context_message_id, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (message_id) DO UPDATE SET
           status = EXCLUDED.status,
           raw_payload = EXCLUDED.raw_payload
         RETURNING (xmax = 0) AS is_inserted`,
        [
          r.message_id,
          r.phone_number_id,
          r.wa_number,
          r.contact_number,
          r.to_number,
          r.direction,
          r.message_type,
          r.message_body,
          r.raw_payload,
          r.media_url,
          r.media_mime_type,
          r.media_filename,
          r.status,
          r.timestamp,
          r.context_message_id,
          orgId,
        ]
      );

      const isNewMessage = insertRes.rows[0]?.is_inserted === true;
      if (!isNewMessage) {
        duplicateCount++;
        // Duplicate delivery from Meta: do not re-increment unread count or re-emit creation events
        continue;
      }

      storedCount++;

      // ── Resolve / create contact and lead ───────────────────────────
      let contactId = null;
      let contactInserted = false;
      if (r.contact_number && r.wa_number) {
        const cName = (r.contact_name || '').trim().slice(0, 255) || null;
        const contactRes = await client.query(
          `INSERT INTO coexistence.contacts
             (wa_number, contact_number, name, profile_name, organization_id, lead_status)
           VALUES ($1, $2, $3, $3, $4, 'new')
           ON CONFLICT (wa_number, contact_number) DO UPDATE SET
             profile_name = CASE WHEN coexistence.contacts.organization_id IS NOT DISTINCT FROM EXCLUDED.organization_id
                                 THEN COALESCE(EXCLUDED.profile_name, coexistence.contacts.profile_name)
                                 ELSE coexistence.contacts.profile_name END,
             name = CASE WHEN coexistence.contacts.organization_id IS NOT DISTINCT FROM EXCLUDED.organization_id
                         THEN COALESCE(coexistence.contacts.name, EXCLUDED.name)
                         ELSE coexistence.contacts.name END,
             updated_at = NOW()
           WHERE coexistence.contacts.organization_id IS NOT DISTINCT FROM EXCLUDED.organization_id
           RETURNING id, organization_id, (xmax = 0) AS is_inserted`,
          [r.wa_number, r.contact_number, cName, orgId]
        );

        if (contactRes.rows[0]) {
          contactId = contactRes.rows[0].id;
          contactInserted = contactRes.rows[0].is_inserted === true;
        }

        // Audit lead activity if new contact
        if (contactInserted && orgId) {
          await client.query(
            `INSERT INTO coexistence.lead_activities
               (organization_id, wa_number, contact_number, kind, summary)
             VALUES ($1,$2,$3,'created',$4)`,
            [orgId, r.wa_number, r.contact_number, `Lead created from inbound WhatsApp message`]
          ).catch(() => {});
        }
      }

      // ── Resolve / create conversation ──────────────────────────────
      let conversationId = null;
      let unreadCount = 1;
      if (orgId && acct.accountId && r.contact_number && r.wa_number) {
        const convRes = await client.query(
          `INSERT INTO coexistence.conversations
             (organization_id, whatsapp_account_id, wa_number, contact_number, last_message_at, unread_count)
           VALUES ($1, $2, $3, $4, NOW(), 1)
           ON CONFLICT (organization_id, whatsapp_account_id, contact_number)
           DO UPDATE SET
             last_message_at = NOW(),
             unread_count = coexistence.conversations.unread_count + 1,
             updated_at = NOW()
           RETURNING id, unread_count`,
          [orgId, acct.accountId, r.wa_number, r.contact_number]
        );
        if (convRes.rows[0]) {
          conversationId = convRes.rows[0].id;
          unreadCount = convRes.rows[0].unread_count;
        }
      }

      // ── Media handling ─────────────────────────────────────────────
      if (SUPPORTED_MEDIA_TYPES.has(r.message_type) && r.media_url && r.message_id) {
        try {
          const { markPending } = require('./mediaDownloader');
          const { enqueueMediaDownload } = require('../queue/mediaQueue');
          await markPending(r.message_id);
          enqueueMediaDownload(r.message_id, orgId).catch(() => {});
        } catch { /* media queue optional in unit test environment */ }
      }

      // Schedule scoped realtime emits for after transaction commits
      if (orgId) {
        incomingEmits.push({
          orgId,
          record: r,
          contactId,
          contactInserted,
          conversationId,
          unreadCount,
        });
      }
    }

    // ── Backfill display phone number on account if missing ────────
    const backfilled = new Set();
    for (const r of records) {
      if (!r.phone_number_id || !r.wa_number || backfilled.has(r.phone_number_id)) continue;
      backfilled.add(r.phone_number_id);
      await client.query(
        `UPDATE coexistence.whatsapp_accounts
            SET display_phone_number = $1
          WHERE phone_number_id = $2
            AND (display_phone_number IS NULL OR display_phone_number = '')`,
        [r.wa_number, r.phone_number_id]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await auditWebhookProcessed(auditId, {
      status: 'error',
      error: err.message,
      processingMs: Date.now() - startTime,
      db,
    });
    throw err;
  } finally {
    client.release();
  }

  // ── Emit organization-scoped realtime socket events ─────────────
  for (const item of incomingEmits) {
    // 1. Inbound message socket event
    emitInboundMessage(item.orgId, item.record);

    // 2. Conversation updated socket event
    emitConversationUpdated(item.orgId, {
      waNumber: item.record.wa_number,
      contactNumber: item.record.contact_number,
      lastMessageAt: item.record.timestamp,
      unreadCount: item.unreadCount,
      lastMessagePreview: item.record.message_body,
    });

    // 2b. Unread count update socket event
    emitUnreadCountUpdate(item.orgId, {
      waNumber: item.record.wa_number,
      contactNumber: item.record.contact_number,
      unreadCount: item.unreadCount,
    });

    // 3. Lead created CRM socket event if a new contact was created
    if (item.contactInserted && item.contactId) {
      emitCrmEvent(item.orgId, 'lead-created', {
        id: item.contactId,
        waNumber: item.record.wa_number,
        contactNumber: item.record.contact_number,
        leadStatus: 'new',
      });
    }
  }

  for (const s of statusUpdates) {
    emitMessageStatus(s.orgId, s);
  }

  // ── Phase 6: AI pipeline dispatch ──────────────────────────────────────
  // Fire-and-forget after commit so the webhook ACKs quickly (Meta's 20s
  // ceiling). Each inbound record is independently routed to the active agent
  // (if any) via agentRouter.routeIfActive(), which enqueues a BullMQ job.
  // Outbound messages carry direction='outgoing' so they are never re-routed.
  // Status and reaction records are also guarded inside routeIfActive().
  if (incomingEmits.length > 0) {
    const agentRouter = getAgentRouter();
    if (agentRouter) {
      for (const item of incomingEmits) {
        if (item.record.direction !== 'incoming') continue;
        const enriched = { ...item.record, organizationId: item.orgId };
        agentRouter.routeIfActive(enriched).then((result) => {
          if (result && result.agentId) {
            if (result.skipped) {
              console.log(`[webhook:ai-skip] reason=${result.skipped} agentId=${result.agentId} contactNumber=${item.record.contact_number}`);
            } else if (result.handedOff) {
              console.log(`[webhook:ai-handoff] agentId=${result.agentId} contactNumber=${item.record.contact_number}`);
            } else {
              console.log(`[webhook:ai-route] agentId=${result.agentId} contactNumber=${item.record.contact_number} messageId=${item.record.message_id}`);
            }
          }
        }).catch((err) => {
          console.error(`[webhook:ai-route] dispatch error: ${err.message} contactNumber=${item.record.contact_number}`);
        });
      }
    }
  }

  await auditWebhookProcessed(auditId, {
    status: 'processed',
    recordsExtracted: storedCount,
    processingMs: Date.now() - startTime,
    db,
  });

  return { ok: true, status: 200, stored: storedCount, duplicates: duplicateCount };
}

module.exports = {
  STATUS_RANK,
  normalizePhone,
  pickPhoneNumberId,
  pickWabaId,
  verifyWebhookSubscription,
  resolveAccountFromAsset,
  parseMetaWebhookPayload,
  processWebhookEvent,
};
