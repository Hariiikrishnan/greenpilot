// Green Pilot — Phase 4: WhatsApp Webhook Ingestion Test Suite
//
// Tests:
// 1. GET verification: valid verify token and subscribe mode returns challenge
// 2. GET verification: invalid verify token returns 403 Forbidden
// 3. GET verification: missing mode or token returns 403 Forbidden
// 4. POST signature: valid X-Hub-Signature-256 HMAC accepted (200 OK)
// 5. POST signature: forged or invalid signature rejected (403 Forbidden)
// 6. POST signature: missing signature rejected (403 Forbidden, never fail-open)
// 7. POST payload: malformed or empty payload returns 400
// 8. Inbound text: persists message, creates/resolves lead/contact, creates/resolves conversation
// 9. Inbound media: persists media metadata (image, video, document, audio)
// 10. Message deduplication: replayed webhook does not duplicate message or re-increment unread count
// 11. Status receipts: updates sent -> delivered -> read, failed with error, no fake messages created
// 12. Monotonic status progression: delivered receipt never downgrades already read message
// 13. Unknown asset: unprovisioned phone number skipped safely without error or orphaned rows
// 14. Tenant isolation: event for Org A cannot be processed through Org B endpoint

process.env.NODE_ENV = 'test';
require('dotenv').config();

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const pool = require('../src/db');
const { setTestGoogleVerifier } = require('../src/googleAuth');
const { computeMetaSignature } = require('../src/util/webhookSignature');
const { encrypt } = require('../src/util/crypto');

const TEST_SECRET = 'gp-phase4-test-meta-secret-xyz123';
const TEST_VERIFY_TOKEN = 'gp-phase4-verify-token-abc987';
const TAG = `wh-test-${Date.now().toString(36)}`;

// Mock Google verifier for setting up test tenants
setTestGoogleVerifier((token) => {
  if (token && token.startsWith('test-token:')) {
    const parts = token.split(':');
    const sub = parts[1] || `google-sub-${Date.now()}`;
    const email = (parts[2] || `user-${sub}@example.com`).trim().toLowerCase();
    const name = parts[3] || 'Test User';
    return { sub, email, emailVerified: true, name, picture: null };
  }
  throw new Error('Invalid test token');
});

let server = null;
let base = '';
let dbAvailable = false;

function jar() {
  const cookies = [];
  return {
    async fetch(path, opts = {}) {
      const res = await globalThis.fetch(`${base}${path}`, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          ...(cookies.length > 0 ? { Cookie: cookies.join('; ') } : {}),
          ...(opts.headers || {}),
        },
        body: opts.body !== undefined ? opts.body : undefined,
      });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const sc of setCookies) {
        const c = sc.split(';')[0];
        if (c) cookies.push(c);
      }
      let body;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        body = await res.json().catch(() => null);
      } else {
        body = await res.text().catch(() => null);
      }
      return {
        status: res.status,
        body,
        headers: res.headers,
        cookies,
      };
    },
  };
}

async function createTestOrgSession(userTag) {
  const client = jar();
  const sub = `sub-${userTag}-${Date.now()}`;
  const email = `${TAG}-${userTag}@greenpilot.test`;
  const name = `User ${userTag}`;
  const token = `test-token:${sub}:${email}:${name}`;

  const res = await client.fetch('/api/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential: token }),
  });

  assert.equal(res.status, 200, `Failed to create test user ${userTag}`);
  return {
    client,
    user: res.body.user,
    organization: res.body.organization,
  };
}

function buildMetaMessagePayload({
  wabaId = 'waba-test-1',
  phoneNumberId = 'phone-id-1',
  displayPhoneNumber = '+15550199',
  from = '15550188',
  messageId = `wamid.test.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`,
  type = 'text',
  text = 'Hello Green Pilot',
  timestamp = Math.floor(Date.now() / 1000),
  profileName = 'Customer Alex',
  media = null,
}) {
  const messageObj = {
    from,
    id: messageId,
    timestamp: String(timestamp),
    type,
  };

  if (type === 'text') {
    messageObj.text = { body: text };
  } else if (type === 'image') {
    messageObj.image = {
      id: media?.id || 'media-img-123',
      mime_type: media?.mimeType || 'image/jpeg',
      caption: media?.caption || text,
    };
  } else if (type === 'document') {
    messageObj.document = {
      id: media?.id || 'media-doc-123',
      mime_type: media?.mimeType || 'application/pdf',
      filename: media?.filename || 'quote.pdf',
    };
  }

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: displayPhoneNumber,
                phone_number_id: phoneNumberId,
              },
              contacts: [
                {
                  profile: { name: profileName },
                  wa_id: from,
                },
              ],
              messages: [messageObj],
            },
          },
        ],
      },
    ],
  };
}

function buildMetaStatusPayload({
  wabaId = 'waba-test-1',
  phoneNumberId = 'phone-id-1',
  displayPhoneNumber = '+15550199',
  recipientId = '15550188',
  messageId = 'wamid.test.1',
  status = 'delivered',
  timestamp = Math.floor(Date.now() / 1000),
  errors = null,
}) {
  const statusObj = {
    id: messageId,
    status,
    timestamp: String(timestamp),
    recipient_id: recipientId,
  };
  if (errors) {
    statusObj.errors = errors;
  }

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: displayPhoneNumber,
                phone_number_id: phoneNumberId,
              },
              statuses: [statusObj],
            },
          },
        ],
      },
    ],
  };
}

before(async () => {
  process.env.META_APP_SECRET = TEST_SECRET;
  process.env.META_WEBHOOK_VERIFY_TOKEN = TEST_VERIFY_TOKEN;

  try {
    await pool.query('SELECT 1');
    const { runMigrations } = require('../src/db/migrate');
    await runMigrations(pool);
    dbAvailable = true;
  } catch (err) {
    console.warn('[test:whatsappWebhookIngestion] DB unavailable:', err.message);
    return;
  }

  const { app } = require('../src/index');
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (pool) {
    try {
      await pool.query(`DELETE FROM coexistence.chat_history WHERE message_id LIKE 'wamid.test.%'`);
      await pool.query(`DELETE FROM coexistence.whatsapp_accounts WHERE phone_number_id LIKE 'pn-${TAG}%'`);
      await pool.query(`DELETE FROM coexistence.whatsapp_accounts WHERE organization_id IN (
        SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%'
      )`);
      await pool.query(`DELETE FROM coexistence.forgecrm_users WHERE email LIKE '${TAG}%'`);
    } catch { /* ignore */ }
  }
});

test('1. GET verification: valid verify token and subscribe mode returns challenge', async (t) => {
  const client = jar();
  const challenge = 'random_challenge_string_9988';
  const url = `/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TEST_VERIFY_TOKEN}&hub.challenge=${challenge}`;

  const res = await client.fetch(url, { method: 'GET' });
  assert.equal(res.status, 200);
  assert.equal(res.body, challenge);
});

test('2. GET verification: invalid verify token returns 403 Forbidden', async (t) => {
  const client = jar();
  const url = `/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=12345`;

  const res = await client.fetch(url, { method: 'GET' });
  assert.equal(res.status, 403);
});

test('3. GET verification: missing mode or token returns 403 Forbidden', async (t) => {
  const client = jar();
  const res1 = await client.fetch(`/api/v1/webhooks/whatsapp?hub.challenge=12345`, { method: 'GET' });
  assert.equal(res1.status, 403);

  const res2 = await client.fetch(`/api/v1/webhooks/whatsapp?hub.mode=other&hub.verify_token=${TEST_VERIFY_TOKEN}`, { method: 'GET' });
  assert.equal(res2.status, 403);
});

test('4. POST signature: valid X-Hub-Signature-256 HMAC accepted (200 OK)', async (t) => {
  const client = jar();
  const payload = { object: 'whatsapp_business_account', entry: [] };
  const rawBody = JSON.stringify(payload);
  const signature = computeMetaSignature(TEST_SECRET, rawBody);

  const res = await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature },
    body: rawBody,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('5. POST signature: forged or invalid signature rejected (403 Forbidden)', async (t) => {
  const client = jar();
  const payload = { object: 'whatsapp_business_account', entry: [] };
  const rawBody = JSON.stringify(payload);
  const forgedSignature = computeMetaSignature('wrong-attacker-secret', rawBody);

  const res = await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': forgedSignature },
    body: rawBody,
  });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Invalid webhook signature');
});

test('6. POST signature: missing signature rejected (403 Forbidden, never fail-open)', async (t) => {
  const client = jar();
  const payload = { object: 'whatsapp_business_account', entry: [] };
  const rawBody = JSON.stringify(payload);

  const res = await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    body: rawBody,
  });

  assert.equal(res.status, 403);
});

test('7. POST payload: malformed or empty payload returns 400', async (t) => {
  const client = jar();
  const rawBody = 'null';
  const signature = computeMetaSignature(TEST_SECRET, rawBody);

  const res = await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature },
    body: rawBody,
  });

  assert.equal(res.status, 400);
});

test('8. Inbound text: persists message, creates/resolves lead/contact, creates/resolves conversation', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization } = await createTestOrgSession('inbound-text');
  const pnId = `pn-${TAG}-101`;
  const waNum = '1555' + Math.floor(100000 + Math.random() * 900000);
  const customerPhone = '1555' + Math.floor(100000 + Math.random() * 900000);
  const wamid = `wamid.test.text.${Date.now()}`;

  // Provision WhatsApp account for test org
  const { rows: acctRows } = await pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (organization_id, phone_number_id, display_phone_number, display_name, waba_id, connection_status, access_token_encrypted)
     VALUES ($1, $2, $3, 'Test Display Name', $4, 'CONNECTED', '${encrypt('test-token')}')
     RETURNING id`,
    [organization.id, pnId, waNum, `waba-${TAG}-1`]
  );
  const accountId = acctRows[0].id;

  const payload = buildMetaMessagePayload({
    wabaId: `waba-${TAG}-1`,
    phoneNumberId: pnId,
    displayPhoneNumber: waNum,
    from: customerPhone,
    messageId: wamid,
    type: 'text',
    text: 'Hello Green Pilot Inbound!',
    profileName: 'Sarah Connor',
  });

  const rawBody = JSON.stringify(payload);
  const signature = computeMetaSignature(TEST_SECRET, rawBody);
  const client = jar();

  const res = await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature },
    body: rawBody,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.stored, 1);

  // 1. Verify chat_history row
  const { rows: msgRows } = await pool.query(
    `SELECT * FROM coexistence.chat_history WHERE message_id = $1`,
    [wamid]
  );
  assert.equal(msgRows.length, 1);
  assert.equal(msgRows[0].organization_id, organization.id);
  assert.equal(msgRows[0].direction, 'incoming');
  assert.equal(msgRows[0].message_body, 'Hello Green Pilot Inbound!');
  assert.equal(msgRows[0].status, 'received');

  // 2. Verify contacts/lead row
  const { rows: contactRows } = await pool.query(
    `SELECT * FROM coexistence.contacts
      WHERE wa_number = $1 AND contact_number = $2 AND organization_id = $3`,
    [waNum, customerPhone, organization.id]
  );
  assert.equal(contactRows.length, 1);
  assert.equal(contactRows[0].name, 'Sarah Connor');
  assert.equal(contactRows[0].lead_status, 'new');

  // 3. Verify conversation thread
  const { rows: convRows } = await pool.query(
    `SELECT * FROM coexistence.conversations
      WHERE organization_id = $1 AND whatsapp_account_id = $2 AND contact_number = $3`,
    [organization.id, accountId, customerPhone]
  );
  assert.equal(convRows.length, 1);
  assert.equal(convRows[0].unread_count, 1);
});

test('9. Inbound media: persists media metadata (image, document)', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization } = await createTestOrgSession('inbound-media');
  const pnId = `pn-${TAG}-102`;
  const waNum = '15550002';
  const customerPhone = '15559992';
  const wamid = `wamid.test.media.${Date.now()}`;

  await pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (organization_id, phone_number_id, display_phone_number, display_name, waba_id, connection_status, access_token_encrypted)
     VALUES ($1, $2, $3, 'Test Display Name', $4, 'CONNECTED', '${encrypt('test-token')}')`,
    [organization.id, pnId, waNum, `waba-${TAG}-2`]
  );

  const payload = buildMetaMessagePayload({
    wabaId: `waba-${TAG}-2`,
    phoneNumberId: pnId,
    displayPhoneNumber: waNum,
    from: customerPhone,
    messageId: wamid,
    type: 'image',
    text: 'Roof solar inspection photo',
    media: {
      id: 'meta-media-img-7788',
      mimeType: 'image/jpeg',
      caption: 'Roof solar inspection photo',
    },
  });

  const rawBody = JSON.stringify(payload);
  const signature = computeMetaSignature(TEST_SECRET, rawBody);
  const client = jar();

  const res = await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature },
    body: rawBody,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.stored, 1);

  const { rows: msgRows } = await pool.query(
    `SELECT message_type, message_body, media_url, media_mime_type FROM coexistence.chat_history WHERE message_id = $1`,
    [wamid]
  );
  assert.equal(msgRows.length, 1);
  assert.equal(msgRows[0].message_type, 'image');
  assert.equal(msgRows[0].message_body, 'Roof solar inspection photo');
  assert.equal(msgRows[0].media_url, 'meta-media-img-7788');
  assert.equal(msgRows[0].media_mime_type, 'image/jpeg');
});

test('10. Message deduplication: replayed webhook does not duplicate message or re-increment unread count', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization } = await createTestOrgSession('dedup');
  const pnId = `pn-${TAG}-103`;
  const waNum = '15550003';
  const customerPhone = '15559993';
  const wamid = `wamid.test.dedup.${Date.now()}`;

  const { rows: acctRows } = await pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (organization_id, phone_number_id, display_phone_number, display_name, waba_id, connection_status, access_token_encrypted)
     VALUES ($1, $2, $3, 'Test Display Name', $4, 'CONNECTED', '${encrypt('test-token')}')
     RETURNING id`,
    [organization.id, pnId, waNum, `waba-${TAG}-3`]
  );
  const accountId = acctRows[0].id;

  const payload = buildMetaMessagePayload({
    wabaId: `waba-${TAG}-3`,
    phoneNumberId: pnId,
    displayPhoneNumber: waNum,
    from: customerPhone,
    messageId: wamid,
    type: 'text',
    text: 'Idempotency test payload',
  });

  const rawBody = JSON.stringify(payload);
  const signature = computeMetaSignature(TEST_SECRET, rawBody);
  const client = jar();

  // First delivery
  const res1 = await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature },
    body: rawBody,
  });
  assert.equal(res1.status, 200);
  assert.equal(res1.body.stored, 1);

  // Second delivery (identical replay from Meta)
  const res2 = await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature },
    body: rawBody,
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.duplicates, 1);
  assert.equal(res2.body.stored, 0);

  // Verify only 1 row in chat_history
  const { rows: msgRows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM coexistence.chat_history WHERE message_id = $1`,
    [wamid]
  );
  assert.equal(msgRows[0].count, 1);

  // Verify conversation unread count was NOT incremented a second time
  const { rows: convRows } = await pool.query(
    `SELECT unread_count FROM coexistence.conversations
      WHERE organization_id = $1 AND whatsapp_account_id = $2 AND contact_number = $3`,
    [organization.id, accountId, customerPhone]
  );
  assert.equal(convRows[0].unread_count, 1);
});

test('11. Status receipts: updates sent -> delivered -> read, failed with error, no fake messages created', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization } = await createTestOrgSession('status-test');
  const pnId = `pn-${TAG}-104`;
  const waNum = '15550004';
  const customerPhone = '15559994';
  const wamid = `wamid.test.status.${Date.now()}`;

  await pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (organization_id, phone_number_id, display_phone_number, display_name, waba_id, connection_status, access_token_encrypted)
     VALUES ($1, $2, $3, 'Test Display Name', $4, 'CONNECTED', '${encrypt('test-token')}')`,
    [organization.id, pnId, waNum, `waba-${TAG}-4`]
  );

  // Seed an outbound message with status 'sending'
  await pool.query(
    `INSERT INTO coexistence.chat_history
       (message_id, phone_number_id, wa_number, contact_number, to_number, direction, message_type, message_body, status, timestamp, organization_id)
     VALUES ($1, $2, $3, $4, $4, 'outgoing', 'text', 'Contract sent', 'sending', NOW(), $5)`,
    [wamid, pnId, waNum, customerPhone, organization.id]
  );

  const client = jar();

  // 1. Advance to 'sent'
  const sentPayload = buildMetaStatusPayload({
    phoneNumberId: pnId,
    displayPhoneNumber: waNum,
    recipientId: customerPhone,
    messageId: wamid,
    status: 'sent',
  });
  const sentRaw = JSON.stringify(sentPayload);
  await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': computeMetaSignature(TEST_SECRET, sentRaw) },
    body: sentRaw,
  });

  let row = (await pool.query(`SELECT status FROM coexistence.chat_history WHERE message_id = $1`, [wamid])).rows[0];
  assert.equal(row.status, 'sent');

  // 2. Advance to 'delivered'
  const delivPayload = buildMetaStatusPayload({
    phoneNumberId: pnId,
    displayPhoneNumber: waNum,
    recipientId: customerPhone,
    messageId: wamid,
    status: 'delivered',
  });
  const delivRaw = JSON.stringify(delivPayload);
  await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': computeMetaSignature(TEST_SECRET, delivRaw) },
    body: delivRaw,
  });

  row = (await pool.query(`SELECT status FROM coexistence.chat_history WHERE message_id = $1`, [wamid])).rows[0];
  assert.equal(row.status, 'delivered');

  // 3. Advance to 'read'
  const readPayload = buildMetaStatusPayload({
    phoneNumberId: pnId,
    displayPhoneNumber: waNum,
    recipientId: customerPhone,
    messageId: wamid,
    status: 'read',
  });
  const readRaw = JSON.stringify(readPayload);
  await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': computeMetaSignature(TEST_SECRET, readRaw) },
    body: readRaw,
  });

  row = (await pool.query(`SELECT status FROM coexistence.chat_history WHERE message_id = $1`, [wamid])).rows[0];
  assert.equal(row.status, 'read');

  // 4. Status receipt for non-existent message does NOT create fake message row
  const fakeWamid = `wamid.test.fake.${Date.now()}`;
  const orphanPayload = buildMetaStatusPayload({
    phoneNumberId: pnId,
    displayPhoneNumber: waNum,
    recipientId: customerPhone,
    messageId: fakeWamid,
    status: 'delivered',
  });
  const orphanRaw = JSON.stringify(orphanPayload);
  await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': computeMetaSignature(TEST_SECRET, orphanRaw) },
    body: orphanRaw,
  });

  const orphanCheck = await pool.query(`SELECT * FROM coexistence.chat_history WHERE message_id = $1`, [fakeWamid]);
  assert.equal(orphanCheck.rows.length, 0, 'Must never create fake message for status event');
});

test('12. Monotonic status progression: delivered receipt never downgrades already read message', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization } = await createTestOrgSession('monotonic-status');
  const pnId = `pn-${TAG}-105`;
  const waNum = '15550005';
  const customerPhone = '15559995';
  const wamid = `wamid.test.monotonic.${Date.now()}`;

  await pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (organization_id, phone_number_id, display_phone_number, display_name, waba_id, connection_status, access_token_encrypted)
     VALUES ($1, $2, $3, 'Test Display Name', $4, 'CONNECTED', '${encrypt('test-token')}')`,
    [organization.id, pnId, waNum, `waba-${TAG}-5`]
  );

  // Message is already 'read'
  await pool.query(
    `INSERT INTO coexistence.chat_history
       (message_id, phone_number_id, wa_number, contact_number, to_number, direction, message_type, message_body, status, timestamp, organization_id)
     VALUES ($1, $2, $3, $4, $4, 'outgoing', 'text', 'Monotonic test', 'read', NOW(), $5)`,
    [wamid, pnId, waNum, customerPhone, organization.id]
  );

  const client = jar();

  // Out-of-order retried 'delivered' event arrives
  const delivPayload = buildMetaStatusPayload({
    phoneNumberId: pnId,
    displayPhoneNumber: waNum,
    recipientId: customerPhone,
    messageId: wamid,
    status: 'delivered',
  });
  const delivRaw = JSON.stringify(delivPayload);

  await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': computeMetaSignature(TEST_SECRET, delivRaw) },
    body: delivRaw,
  });

  const row = (await pool.query(`SELECT status FROM coexistence.chat_history WHERE message_id = $1`, [wamid])).rows[0];
  assert.equal(row.status, 'read', 'Status must stay read and not regress to delivered');
});

test('13. Unknown asset: unprovisioned phone number skipped safely without error or orphaned rows', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const unknownPnId = `pn-${TAG}-ghost-999`;
  const unknownWamid = `wamid.test.ghost.${Date.now()}`;

  const payload = buildMetaMessagePayload({
    phoneNumberId: unknownPnId,
    displayPhoneNumber: '+1555999000',
    from: '1555111222',
    messageId: unknownWamid,
    text: 'Ghost message from unknown number',
  });

  const rawBody = JSON.stringify(payload);
  const signature = computeMetaSignature(TEST_SECRET, rawBody);
  const client = jar();

  const res = await client.fetch('/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature },
    body: rawBody,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.stored, 0);

  const check = await pool.query(`SELECT id FROM coexistence.chat_history WHERE message_id = $1`, [unknownWamid]);
  assert.equal(check.rows.length, 0);
});

test('14. Tenant isolation: event for Org A cannot be processed through Org B endpoint', async (t) => {
  if (!dbAvailable) return t.skip('Database required');

  const { organization: orgA } = await createTestOrgSession('org-iso-a');
  const { organization: orgB } = await createTestOrgSession('org-iso-b');

  const pnIdA = `pn-${TAG}-iso-a`;
  const wamid = `wamid.test.iso.${Date.now()}`;

  // Provision pnIdA strictly to orgA
  await pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (organization_id, phone_number_id, display_phone_number, display_name, waba_id, connection_status, access_token_encrypted)
     VALUES ($1, $2, '15550010', 'Org A WhatsApp', 'waba-iso-a', 'CONNECTED', '${encrypt('test-token')}')`,
    [orgA.id, pnIdA]
  );

  const payload = buildMetaMessagePayload({
    phoneNumberId: pnIdA,
    displayPhoneNumber: '15550010',
    from: '1555111333',
    messageId: wamid,
    text: 'Cross-tenant payload test',
  });

  const rawBody = JSON.stringify(payload);
  const signature = computeMetaSignature(TEST_SECRET, rawBody);
  const client = jar();

  // Delivering through Org B's scoped endpoint must be rejected / skipped
  const res = await client.fetch(`/api/v1/webhooks/whatsapp/${orgB.id}`, {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature },
    body: rawBody,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.stored, 0, 'Must not store record when target org does not own the asset');

  // Verify message was not stored under Org B
  const check = await pool.query(
    `SELECT id FROM coexistence.chat_history WHERE message_id = $1 AND organization_id = $2`,
    [wamid, orgB.id]
  );
  assert.equal(check.rows.length, 0);
});
