// Green Pilot — Phase 5 Automated Test Suite: Real-Time WhatsApp Inbox + Outbound Messaging

require('dotenv').config();
require('../src/util/instanceSecrets').bootstrapSecrets();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { io: Client } = require('socket.io-client');

const pool = require('../src/db');
const { encrypt } = require('../src/util/crypto');
const { authMiddleware } = require('../src/auth');
const { resolveTenant } = require('../src/middleware/tenant');
const { router: chatsRouter } = require('../src/routes/chats');
const { router: leadsRouter } = require('../src/routes/leads');
const { router: messagesRouter } = require('../src/routes/messages');
const { router: webhookRouter } = require('../src/routes/webhook');
const { initRealtime } = require('../src/realtime/socket');
const emitter = require('../src/realtime/emitter');
const {
  sendWhatsAppMessage,
  setTestMetaClient,
  resetTestMetaClient,
} = require('../src/services/whatsappMessaging');

const JWT_SECRET = process.env.JWT_SECRET || 'forgecrm-dev-secret-change-me';

// Unique suffix per test run to prevent phone number collisions across parallel/sequential runs
const TAG = Date.now().toString().slice(-7);
// Shared WA numbers representing Org A and Org B registered phones
const WA_A = `919${TAG}001`;
const WA_B = `919${TAG}002`;
// Helper to generate unique customer phone numbers per test
function cust(n) { return `918${TAG}${String(n).padStart(3, '0')}`; }

// Test setup helpers
let server;
let baseUrl;
let ioServer;
let orgA, orgB;
let userA, userB;
let tokenA, tokenB;
let waAccountA, waAccountB;

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

test.before(async () => {
  // 1. Create two test organizations
  const orgARes = await pool.query(`
    INSERT INTO coexistence.organizations (name, slug)
    VALUES ('Phase5 Org A', 'phase5-org-a-${TAG}')
    RETURNING id
  `);
  orgA = orgARes.rows[0].id;

  const orgBRes = await pool.query(`
    INSERT INTO coexistence.organizations (name, slug)
    VALUES ('Phase5 Org B', 'phase5-org-b-${TAG}')
    RETURNING id
  `);
  orgB = orgBRes.rows[0].id;

  // 2. Create users and memberships
  const userARes = await pool.query(`
    INSERT INTO coexistence.forgecrm_users (username, email, password, role, display_name, is_active)
    VALUES ('p5_user_a_${TAG}', 'p5_a_${TAG}@example.com', 'hash', 'admin', 'User A ${TAG}', TRUE)
    RETURNING id, username, role, display_name
  `);
  userA = userARes.rows[0];

  const userBRes = await pool.query(`
    INSERT INTO coexistence.forgecrm_users (username, email, password, role, display_name, is_active)
    VALUES ('p5_user_b_${TAG}', 'p5_b_${TAG}@example.com', 'hash', 'admin', 'User B ${TAG}', TRUE)
    RETURNING id, username, role, display_name
  `);
  userB = userBRes.rows[0];

  await pool.query(`
    INSERT INTO coexistence.organization_members (organization_id, user_id, role)
    VALUES ($1, $2, 'admin'), ($3, $4, 'admin')
  `, [orgA, userA.id, orgB, userB.id]);

  tokenA = signToken(userA);
  tokenB = signToken(userB);

  // 3. Create active WhatsApp accounts with encrypted tokens
  const encTokenA = encrypt('meta_test_access_token_org_a');
  const encTokenB = encrypt('meta_test_access_token_org_b');

  const waARes = await pool.query(`
    INSERT INTO coexistence.whatsapp_accounts
      (organization_id, display_name, display_phone_number, phone_number_id, waba_id, access_token_encrypted, is_active, is_default, connection_status)
    VALUES
      ($1, 'Org A WhatsApp', $2, $3, $4, $5, TRUE, TRUE, 'CONNECTED')
    RETURNING *
  `, [orgA, '+' + WA_A, 'phoneA_' + TAG, 'wabaA_' + TAG, encTokenA]);
  waAccountA = waARes.rows[0];

  const waBRes = await pool.query(`
    INSERT INTO coexistence.whatsapp_accounts
      (organization_id, display_name, display_phone_number, phone_number_id, waba_id, access_token_encrypted, is_active, is_default, connection_status)
    VALUES
      ($1, 'Org B WhatsApp', $2, $3, $4, $5, TRUE, TRUE, 'CONNECTED')
    RETURNING *
  `, [orgB, '+' + WA_B, 'phoneB_' + TAG, 'wabaB_' + TAG, encTokenB]);
  waAccountB = waBRes.rows[0];

  // 4. Build Test Express + Socket.IO Server
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  // Public webhook routes
  app.use('/api', webhookRouter);
  app.use('/api/v1', webhookRouter);

  // Authenticated zone
  app.use('/api/v1', authMiddleware, resolveTenant, chatsRouter, leadsRouter, messagesRouter);
  app.use('/api', authMiddleware, resolveTenant, chatsRouter, leadsRouter, messagesRouter);

  server = http.createServer(app);
  ioServer = initRealtime(server);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = 'http://127.0.0.1:' + port;
      resolve();
    });
  });
});

test.after(async () => {
  resetTestMetaClient();
  if (ioServer) ioServer.close();
  if (server) await new Promise(r => server.close(r));
  await pool.query('DELETE FROM coexistence.organizations WHERE id IN ($1, $2)', [orgA, orgB]).catch(() => {});
});

// Helper for authenticated HTTP requests
async function authReq(endpoint, token, orgId, opts = {}) {
  const url = `${baseUrl}${endpoint}`;
  const headers = {
    'Cookie': `forgecrm_token=${token}`,
    'X-Org-Id': orgId,
    'Content-Type': 'application/json',
    ...opts.headers,
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// ── Test 1: Chat Listing & Recent Activity Sorting ───────────────────────────
test('1. GET /api/v1/chats: returns organization conversations sorted by recent activity', async () => {
  const customer1 = cust(101);
  const customer2 = cust(102);

  // Create contacts for Org A — also update organization_id on conflict to prevent cross-org mismatches
  await pool.query(`
    INSERT INTO coexistence.contacts (organization_id, wa_number, contact_number, name)
    VALUES
      ($1, $2, $3, 'Customer One'),
      ($1, $2, $4, 'Customer Two')
    ON CONFLICT (wa_number, contact_number)
    DO UPDATE SET name = EXCLUDED.name, organization_id = EXCLUDED.organization_id
  `, [orgA, WA_A, customer1, customer2]);

  // Insert conversations with distinct timestamps
  await pool.query(`
    INSERT INTO coexistence.conversations (organization_id, whatsapp_account_id, wa_number, contact_number, last_message_at, unread_count)
    VALUES
      ($1, $2, $3, $4, NOW() - INTERVAL '10 minutes', 1),
      ($1, $2, $3, $5, NOW() - INTERVAL '1 minute', 2)
    ON CONFLICT (organization_id, whatsapp_account_id, contact_number)
    DO UPDATE SET last_message_at = EXCLUDED.last_message_at, unread_count = EXCLUDED.unread_count
  `, [orgA, waAccountA.id, WA_A, customer1, customer2]);

  // Insert chat history messages
  await pool.query(`
    INSERT INTO coexistence.chat_history (message_id, phone_number_id, wa_number, contact_number, to_number, direction, message_type, message_body, organization_id, timestamp)
    VALUES
      ($1, $2, $3, $4, $4, 'incoming', 'text', 'Older message from Customer 1', $5, NOW() - INTERVAL '10 minutes'),
      ($6, $2, $3, $7, $7, 'incoming', 'text', 'Newest message from Customer 2', $5, NOW() - INTERVAL '1 minute')
    ON CONFLICT (message_id) DO NOTHING
  `, ['msg-t1-c1-' + TAG, waAccountA.phone_number_id, WA_A, customer1, orgA, 'msg-t1-c2-' + TAG, customer2]);

  const res = await authReq('/api/v1/chats', tokenA, orgA);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.chats));
  assert.ok(res.json.chats.length >= 2);

  // Assert sorted by recent activity: customer2 (1 minute ago) before customer1 (10 minutes ago)
  const c2Idx = res.json.chats.findIndex(c => c.contact_number === customer2);
  const c1Idx = res.json.chats.findIndex(c => c.contact_number === customer1);
  assert.ok(c2Idx !== -1, 'customer2 must be present in chat list');
  assert.ok(c1Idx !== -1, 'customer1 must be present in chat list');
  assert.ok(c2Idx < c1Idx, 'Customer 2 should appear before Customer 1 due to more recent activity');

  // Verify chat shape
  const chat2 = res.json.chats[c2Idx];
  assert.equal(chat2.contact_name, 'Customer Two');
  assert.equal(chat2.last_message, 'Newest message from Customer 2');
  assert.equal(chat2.unread_count, 2);
  assert.equal(chat2.organization_id, orgA);
});

// ── Test 2: Pagination ───────────────────────────────────────────────────────
test('2. GET /api/v1/chats: handles pagination correctly', async () => {
  const resPage1 = await authReq('/api/v1/chats?page=1&limit=1', tokenA, orgA);
  assert.equal(resPage1.status, 200);
  assert.equal(resPage1.json.chats.length, 1);
  assert.equal(resPage1.json.page, 1);
  assert.equal(resPage1.json.limit, 1);
  assert.ok(resPage1.json.total >= 2);
  assert.ok(resPage1.json.totalPages >= 2);

  const resPage2 = await authReq('/api/v1/chats?page=2&limit=1', tokenA, orgA);
  assert.equal(resPage2.status, 200);
  assert.equal(resPage2.json.chats.length, 1);
  assert.equal(resPage2.json.page, 2);
  // Page 1 and Page 2 should have different contacts
  assert.notEqual(resPage1.json.chats[0].contact_number, resPage2.json.chats[0].contact_number);
});

// ── Test 3: Search Filtering ────────────────────────────────────────────────
test('3. GET /api/v1/chats: search filters by contact name and message body', async () => {
  // Search by contact name
  const resName = await authReq('/api/v1/chats?search=Customer One', tokenA, orgA);
  assert.equal(resName.status, 200);
  assert.ok(resName.json.chats.some(c => c.contact_name === 'Customer One'));
  assert.ok(!resName.json.chats.some(c => c.contact_name === 'Customer Two'));

  // Search by message body
  const resBody = await authReq('/api/v1/chats?search=Newest message', tokenA, orgA);
  assert.equal(resBody.status, 200);
  assert.ok(resBody.json.chats.some(c => c.contact_name === 'Customer Two'));
  assert.ok(!resBody.json.chats.some(c => c.contact_name === 'Customer One'));
});

// ── Test 4: Strict Tenant Isolation on Chats ─────────────────────────────────
test('4. GET /api/v1/chats: strict tenant isolation (Org B cannot view Org A chats)', async () => {
  const customer1 = cust(101);
  const customer2 = cust(102);

  // Org B queries chats
  const resB = await authReq('/api/v1/chats', tokenB, orgB);
  assert.equal(resB.status, 200);
  // Must NOT include any Org A conversation
  for (const c of resB.json.chats) {
    assert.equal(c.organization_id, orgB);
    assert.notEqual(c.contact_number, customer1);
    assert.notEqual(c.contact_number, customer2);
  }

  // Token A with forged Org B header fails closed (403 Forbidden)
  const resForged = await authReq('/api/v1/chats', tokenA, orgB);
  assert.equal(resForged.status, 403);
});

// ── Test 5: Lead Messages History ───────────────────────────────────────────
test('5. GET /api/v1/leads/:id/messages: retrieves paginated message history for an org lead', async () => {
  const customer = cust(301);

  // Create lead in Org A — fully unique numbers prevent cross-org upsert issues
  const leadRes = await pool.query(`
    INSERT INTO coexistence.contacts (organization_id, wa_number, contact_number, name, lead_status)
    VALUES ($1, $2, $3, $4, 'qualified')
    ON CONFLICT (wa_number, contact_number)
    DO UPDATE SET name = EXCLUDED.name, organization_id = EXCLUDED.organization_id, lead_status = EXCLUDED.lead_status
    RETURNING id
  `, [orgA, WA_A, customer, 'Lead Test ' + TAG]);
  const leadId = leadRes.rows[0].id;

  // Insert 3 messages
  for (let i = 1; i <= 3; i++) {
    await pool.query(`
      INSERT INTO coexistence.chat_history
        (message_id, phone_number_id, wa_number, contact_number, to_number, direction, message_type, message_body, organization_id, timestamp)
      VALUES
        ($1, $2, $3, $4, $4, $5, 'text', $6, $7, NOW() - ($8 || ' minutes')::interval)
      ON CONFLICT (message_id) DO NOTHING
    `, [
      'lead-msg-' + TAG + '-' + i,
      waAccountA.phone_number_id,
      WA_A,
      customer,
      i % 2 === 0 ? 'outgoing' : 'incoming',
      'Message number ' + i,
      orgA,
      10 - i,
    ]);
  }

  const res = await authReq('/api/v1/leads/' + leadId + '/messages', tokenA, orgA);
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 3);
  assert.equal(res.json.messages.length, 3);
  // Chronological order (oldest first for display)
  assert.equal(res.json.messages[0].message_body, 'Message number 1');
  assert.equal(res.json.messages[2].message_body, 'Message number 3');
});

// ── Test 6: Lead Messages Tenant Isolation ──────────────────────────────────
test('6. GET & POST /api/v1/leads/:id/messages: tenant isolation (Org B cannot view or send to Org A lead)', async () => {
  const customer = cust(401);

  const leadRes = await pool.query(`
    INSERT INTO coexistence.contacts (organization_id, wa_number, contact_number, name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (wa_number, contact_number)
    DO UPDATE SET name = EXCLUDED.name, organization_id = EXCLUDED.organization_id
    RETURNING id
  `, [orgA, WA_A, customer, 'Private Lead Org A ' + TAG]);
  const leadId = leadRes.rows[0].id;

  // Org B attempts to read Org A's lead messages -> 404
  const resGetB = await authReq('/api/v1/leads/' + leadId + '/messages', tokenB, orgB);
  assert.equal(resGetB.status, 404);

  // Org B attempts to send message to Org A's lead -> 404
  const resPostB = await authReq('/api/v1/leads/' + leadId + '/messages', tokenB, orgB, {
    method: 'POST',
    body: JSON.stringify({ text: 'Unauthorized message' }),
  });
  assert.equal(resPostB.status, 404);
});

// ── Test 7: Outbound Message via Lead Endpoint ───────────────────────────────
test('7. POST /api/v1/leads/:id/messages: sends outbound WhatsApp message, records wamid and sent status', async () => {
  const customer = cust(501);

  const leadRes = await pool.query(`
    INSERT INTO coexistence.contacts (organization_id, wa_number, contact_number, name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (wa_number, contact_number)
    DO UPDATE SET name = EXCLUDED.name, organization_id = EXCLUDED.organization_id
    RETURNING id
  `, [orgA, WA_A, customer, 'Outbound Lead Target ' + TAG]);
  const leadId = leadRes.rows[0].id;

  // Mock Meta Cloud API response
  const expectedWamid = 'wamid.HBgL' + TAG;
  setTestMetaClient(async ({ account, toNumber, text }) => {
    assert.equal(account.phoneNumberId, waAccountA.phone_number_id);
    assert.equal(toNumber, customer);
    assert.equal(text, 'Hello from Green Pilot Lead API');
    return {
      messaging_product: 'whatsapp',
      contacts: [{ input: toNumber, wa_id: toNumber }],
      messages: [{ id: expectedWamid }],
    };
  });

  const res = await authReq('/api/v1/leads/' + leadId + '/messages', tokenA, orgA, {
    method: 'POST',
    body: JSON.stringify({ text: 'Hello from Green Pilot Lead API' }),
  });

  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.messageId, expectedWamid);
  assert.equal(res.json.status, 'sent');

  // Verify persisted row in chat_history
  const { rows } = await pool.query(
    'SELECT * FROM coexistence.chat_history WHERE message_id = $1 AND organization_id = $2',
    [expectedWamid, orgA]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'sent');
  assert.equal(rows[0].direction, 'outgoing');
  assert.equal(rows[0].message_body, 'Hello from Green Pilot Lead API');
});

// ── Test 8: Dedicated Messaging Service Direct Send ─────────────────────────────
test('8. whatsappMessaging.sendWhatsAppMessage: resolves connection, decrypts credentials, stores wamid', async () => {
  const expectedWamid = 'wamid.SERVICE_' + TAG;
  let invokedWithToken = null;

  setTestMetaClient(async ({ account, toNumber, text }) => {
    invokedWithToken = account.accessToken;
    return {
      messages: [{ id: expectedWamid }],
    };
  });

  const toNumber = cust(601);
  const result = await sendWhatsAppMessage({
    organizationId: orgA,
    toNumber,
    text: 'Direct service send test',
  });

  assert.equal(result.ok, true);
  assert.equal(result.messageId, expectedWamid);
  assert.equal(result.status, 'sent');
  assert.equal(invokedWithToken, 'meta_test_access_token_org_a'); // verified AES decrypted token
});

// ── Test 9: Meta API Error Handling ──────────────────────────────────────────
test('9. whatsappMessaging.sendWhatsAppMessage: Meta failure marks status failed with error message', async () => {
  setTestMetaClient(async () => {
    const err = new Error('Meta API error: (#131047) Re-engagement message not allowed outside 24h');
    err.status = 400;
    err.metaError = { code: 131047 };
    throw err;
  });

  await assert.rejects(
    async () => {
      await sendWhatsAppMessage({
        organizationId: orgA,
        toNumber: cust(701),
        text: 'Message that will fail',
      });
    },
    (err) => {
      assert.ok(err.message.includes('outside 24h'));
      assert.ok(err.localId);
      return true;
    }
  );

  // Verify chat_history row was marked as failed
  const { rows } = await pool.query(`
    SELECT * FROM coexistence.chat_history
    WHERE contact_number = $1 AND organization_id = $2
    ORDER BY timestamp DESC LIMIT 1
  `, [cust(701), orgA]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.ok(rows[0].error_message.includes('outside 24h'));
});

// ── Test 10: Realtime Socket.IO Auth & Room Isolation ────────────────────────
test('10. Socket.io: authenticates and joins only authorized org room', async () => {
  const socket = Client(baseUrl, {
    extraHeaders: {
      'Cookie': `forgecrm_token=${tokenA}`,
    },
    transports: ['websocket'],
  });

  await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
  });

  assert.ok(socket.connected);

  // Attempting to join unauthorized room is rejected
  const joinAck = await new Promise((resolve) => {
    socket.emit('join-org', orgB, (ack) => resolve(ack));
  });
  assert.equal(joinAck.ok, false);
  assert.equal(joinAck.code, 'not-member');

  socket.disconnect();
});

// ── Test 11: Realtime Socket.IO Cross-Tenant Isolation ───────────────────────
test('11. Socket.io: Org A socket receives Org A events, Org B socket receives zero', async () => {
  const socketA = Client(baseUrl, {
    extraHeaders: { 'Cookie': 'forgecrm_token=' + tokenA },
    transports: ['websocket'],
  });
  const socketB = Client(baseUrl, {
    extraHeaders: { 'Cookie': 'forgecrm_token=' + tokenB },
    transports: ['websocket'],
  });

  await Promise.all([
    new Promise(r => socketA.on('connect', r)),
    new Promise(r => socketB.on('connect', r)),
  ]);

  const receivedA = [];
  const receivedB = [];

  socketA.on('inbound-message', (data) => receivedA.push(data));
  socketB.on('inbound-message', (data) => receivedB.push(data));

  // Emit an inbound message for Org A using unique TAG wamid
  const uniqueWamid = 'realtime-tenant-' + TAG;
  emitter.emitInboundMessage(orgA, {
    message_id: uniqueWamid,
    wa_number: WA_A,
    contact_number: cust(801),
    message_body: 'Realtime test for Org A ' + TAG,
    status: 'received',
  });

  // Wait 300ms for event propagation
  await new Promise(r => setTimeout(r, 300));

  assert.equal(receivedA.length, 1);
  assert.equal(receivedA[0].messageId, uniqueWamid);
  assert.equal(receivedA[0].organizationId, orgA);

  // Socket B must have received ZERO events!
  assert.equal(receivedB.length, 0, 'Socket B should not receive any events for Org A');

  socketA.disconnect();
  socketB.disconnect();
});

// ── Test 12: Realtime Unread Count Update ────────────────────────────────────
test('12. Realtime unread-count-update: emitted and received on mark-read', async () => {
  const customer1 = cust(101);

  const socketA = Client(baseUrl, {
    extraHeaders: { 'Cookie': 'forgecrm_token=' + tokenA },
    transports: ['websocket'],
  });

  await new Promise(r => socketA.on('connect', r));

  const unreadEvents = [];
  socketA.on('unread-count-update', (data) => unreadEvents.push(data));

  // Call mark-read for contact (WA_A and customer1 = cust(101) set in Test 1)
  const res = await authReq('/api/v1/messages/mark-read', tokenA, orgA, {
    method: 'POST',
    body: JSON.stringify({
      waNumber: WA_A,
      contactNumber: customer1,
    }),
  });

  assert.equal(res.status, 200);

  // Wait 300ms for socket delivery
  await new Promise(r => setTimeout(r, 300));

  assert.ok(unreadEvents.length >= 1);
  const ev = unreadEvents[0];
  assert.equal(ev.contactNumber, customer1);
  assert.equal(ev.unreadCount, 0);
  assert.equal(ev.organizationId, orgA);

  socketA.disconnect();
});
