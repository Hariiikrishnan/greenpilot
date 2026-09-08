// Green Pilot Phase 7 socket authorization + tenant-isolation tests.
//
// DB-FREE by design: boots a real HTTP server + the real Socket.IO layer with
// injected auth/membership fakes, then drives real socket.io-client
// connections. Runs in CI without Postgres.
//
// Fixture:
//   Org A: users A1, A2     Org B: users B1, B2     + user STRANGER (no orgs)
// Covers spec Steps 13–15: valid join, forged join-org, forged room, memberless
// connect, cross-tenant event isolation (all 4 canonical events), safe errors,
// emitter fail-closed rules, and the worker→socket org boundary.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase7-socket-test-secret';

const {
  initRealtime,
  closeRealtime,
  resetRealtimeForTests,
  orgRoom,
  userRoom,
  parseCookieHeader,
  tokenFromHandshake,
} = require('../src/realtime/socket');
const emitter = require('../src/realtime/emitter');
const { io: ioClient } = require('socket.io-client');

const ORG_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const MEMBERSHIPS = {
  101: [{ organization_id: ORG_A }], // A1
  102: [{ organization_id: ORG_A }], // A2
  201: [{ organization_id: ORG_B }], // B1
  202: [{ organization_id: ORG_B }], // B2
  999: [], // STRANGER — authenticated, zero orgs
};

function signToken(id, role = 'member') {
  return jwt.sign({ id, username: `u${id}`, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

const fakeDeps = {
  loadUser: async (id) => ({ id, role: 'member', is_active: true }),
  listOrgs: async (id) => MEMBERSHIPS[id] || [],
  log: () => {},
};

let server = null;
let base = '';

function connectClient(userId, { useAuthToken = false } = {}) {
  const token = signToken(userId);
  return ioClient(base, {
    reconnection: false,
    timeout: 5000,
    auth: useAuthToken ? { token } : undefined,
    extraHeaders: useAuthToken ? {} : { cookie: `forgecrm_token=${token}` },
  });
}

function waitFor(client, event, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    client.once(event, (...args) => { clearTimeout(t); resolve(args); });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

before(async () => {
  resetRealtimeForTests();
  server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  initRealtime(server, { deps: fakeDeps });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = (addr && typeof addr === 'object' ? addr.port : null) || 0;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await closeRealtime();
  resetRealtimeForTests();
  if (server) await new Promise((resolve) => server.close(resolve));
});

// --- Pure helpers -----------------------------------------------------------

test('cookie + token extraction helpers', () => {
  assert.equal(parseCookieHeader('a=1; forgecrm_token=TOK; b=2').forgecrm_token, 'TOK');
  assert.deepEqual(parseCookieHeader(null), {});
  assert.equal(tokenFromHandshake({ auth: { token: 'AUTH' }, headers: {} }), 'AUTH');
  assert.equal(
    tokenFromHandshake({ auth: {}, headers: { cookie: 'forgecrm_token=CK' } }),
    'CK'
  );
  assert.equal(tokenFromHandshake({ auth: {}, headers: {} }), null);
});

test('room naming is canonical org:{id} / user:{id}', () => {
  assert.equal(orgRoom(ORG_A), `org:${ORG_A}`);
  assert.equal(userRoom(101), 'user:101');
});

// --- Handshake auth ---------------------------------------------------------

test('valid member connects and auto-joins its org room', async () => {
  const c = connectClient(101);
  await waitFor(c, 'connect');
  // Proof of room membership: an org-scoped emit reaches the socket.
  const got = waitFor(c, 'conversation-updated');
  emitter.emitToOrg(ORG_A, 'conversation-updated', { waNumber: '1', contactNumber: '2' });
  const [payload] = await got;
  assert.equal(payload.organizationId, ORG_A);
  c.close();
});

test('auth.token handshake also authenticates (native-client path)', async () => {
  const c = connectClient(102, { useAuthToken: true });
  await waitFor(c, 'connect');
  c.close();
});

test('unauthenticated handshake is rejected with a safe error', async () => {
  const c = ioClient(base, { reconnection: false, timeout: 5000 });
  const [err] = await waitFor(c, 'connect_error');
  // Safe error: the client-visible message is exactly the generic string —
  // no stack, no token, no internals.
  assert.equal(err?.message, 'Authentication failed');
  c.close();
});

test('tampered token is rejected', async () => {
  const c = ioClient(base, {
    reconnection: false,
    timeout: 5000,
    extraHeaders: { cookie: 'forgecrm_token=eyJhbGciOiJ9.forged.signature' },
  });
  const [err] = await waitFor(c, 'connect_error');
  assert.equal(err?.message, 'Authentication failed');
  c.close();
});

// --- Room authorization (Steps 13) ------------------------------------------

test('member join-org for its OWN org succeeds', async () => {
  const c = connectClient(101);
  await waitFor(c, 'connect');
  const ack = await c.emitWithAck('join-org', ORG_A);
  assert.equal(ack.ok, true);
  assert.equal(ack.room, orgRoom(ORG_A));
  c.close();
});

test('member join-org for a FOREIGN org is rejected (forged organizationId)', async () => {
  const c = connectClient(101); // member of A only
  await waitFor(c, 'connect');
  const ack = await c.emitWithAck('join-org', ORG_B);
  assert.equal(ack.ok, false);
  assert.equal(ack.code, 'not-member');
  // And the rejection sticks: org B events never arrive.
  let received = false;
  c.on('inbound-message', () => { received = true; });
  emitter.emitInboundMessage(ORG_B, { message_id: 'm-x', wa_number: '1', contact_number: '2' });
  await sleep(250);
  assert.equal(received, false);
  c.close();
});

test('generic join of a foreign org room is rejected', async () => {
  const c = connectClient(101);
  await waitFor(c, 'connect');
  const ack = await c.emitWithAck('join', orgRoom(ORG_B));
  assert.equal(ack.ok, false);
  assert.equal(ack.code, 'forbidden-room');
  c.close();
});

test('generic join of an arbitrary room is rejected (no room probing)', async () => {
  const c = connectClient(101);
  await waitFor(c, 'connect');
  for (const room of ['admin-room', 'org:*', 'org:', 'user:999', 'org:other-org']) {
    const ack = await c.emitWithAck('join', room);
    assert.equal(ack.ok, false, `room ${room} must be rejected`);
  }
  c.close();
});

test('own user room join is allowed', async () => {
  const c = connectClient(101);
  await waitFor(c, 'connect');
  const ack = await c.emitWithAck('join', userRoom(101));
  assert.equal(ack.ok, true);
  c.close();
});

test('authenticated non-member connects but gets no org events', async () => {
  const c = connectClient(999); // STRANGER: valid session, zero orgs
  await waitFor(c, 'connect');
  const ack = await c.emitWithAck('join-org', ORG_A);
  assert.equal(ack.ok, false);
  let received = false;
  c.on('inbound-message', () => { received = true; });
  c.on('message-status-update', () => { received = true; });
  c.on('conversation-updated', () => { received = true; });
  emitter.emitInboundMessage(ORG_A, { message_id: 'm-y', wa_number: '1', contact_number: '2' });
  emitter.emitConversationUpdated(ORG_A, { waNumber: '1', contactNumber: '2' });
  await sleep(250);
  assert.equal(received, false);
  c.close();
});

// --- Event isolation (Step 14): A1+A2 receive, B1+B2 receive nothing --------

async function isolationHarness() {
  const a1 = connectClient(101);
  const a2 = connectClient(102);
  const b1 = connectClient(201);
  const b2 = connectClient(202);
  await Promise.all([waitFor(a1, 'connect'), waitFor(a2, 'connect'), waitFor(b1, 'connect'), waitFor(b2, 'connect')]);
  const hits = { a1: [], a2: [], b1: [], b2: [] };
  const all = { a1, a2, b1, b2 };
  for (const [key, client] of Object.entries(all)) {
    for (const ev of emitter.CANONICAL_EVENTS) {
      client.on(ev, (p) => hits[key].push({ ev, org: p.organizationId }));
    }
  }
  return {
    clients: all,
    hits,
    close() { for (const c of Object.values(all)) c.close(); },
  };
}

async function assertIsolated(emitFn, eventName) {
  const h = await isolationHarness();
  try {
    emitFn();
    await sleep(300);
    assert.ok(h.hits.a1.some((x) => x.ev === eventName && x.org === ORG_A), `A1 must receive ${eventName}`);
    assert.ok(h.hits.a2.some((x) => x.ev === eventName && x.org === ORG_A), `A2 must receive ${eventName}`);
    assert.equal(h.hits.b1.length, 0, `B1 must receive NOTHING (got ${JSON.stringify(h.hits.b1)})`);
    assert.equal(h.hits.b2.length, 0, `B2 must receive NOTHING (got ${JSON.stringify(h.hits.b2)})`);
  } finally {
    h.close();
  }
}

test('isolation: inbound-message reaches only org A', async () => {
  await assertIsolated(
    () => emitter.emitInboundMessage(ORG_A, { message_id: 'iso-m1', wa_number: '1555', contact_number: '1999', message_body: 'hi' }),
    'inbound-message'
  );
});

test('isolation: message-status-update reaches only org A', async () => {
  await assertIsolated(
    () => emitter.emitMessageStatus(ORG_A, { messageId: 'iso-m1', contactNumber: '1999', status: 'read' }),
    'message-status-update'
  );
});

test('isolation: conversation-updated reaches only org A', async () => {
  await assertIsolated(
    () => emitter.emitConversationUpdated(ORG_A, { waNumber: '1555', contactNumber: '1999' }),
    'conversation-updated'
  );
});

test('isolation: lead-qualified reaches only org A', async () => {
  await assertIsolated(
    () => emitter.emitLeadQualified(ORG_A, { contactNumber: '1999', waNumber: '1555' }),
    'lead-qualified'
  );
});

test('isolation is symmetric: org B emit never reaches org A', async () => {
  const h = await isolationHarness();
  try {
    emitter.emitInboundMessage(ORG_B, { message_id: 'iso-m2', wa_number: '1', contact_number: '2' });
    await sleep(300);
    assert.equal(h.hits.a1.length, 0);
    assert.equal(h.hits.a2.length, 0);
    assert.ok(h.hits.b1.length > 0 && h.hits.b2.length > 0);
  } finally {
    h.close();
  }
});

// --- Emitter fail-closed rules (Steps 15–16) --------------------------------

test('emitter refuses unscoped emits (no org inference)', () => {
  for (const bad of [null, undefined, '']) {
    assert.throws(() => emitter.emitToOrg(bad, 'inbound-message', {}), /organizationId is required/);
  }
});

test('emitter refuses unknown events', () => {
  assert.throws(() => emitter.emitToOrg(ORG_A, 'do-anything', {}), /unknown event/);
});

test('emitter strips secrets from payloads', async () => {
  const c = connectClient(101);
  await waitFor(c, 'connect');
  const got = waitFor(c, 'conversation-updated');
  emitter.emitToOrg(ORG_A, 'conversation-updated', {
    waNumber: '1', contactNumber: '2',
    accessToken: 'SECRET', token: 'SECRET', secret: 'SECRET',
    password: 'SECRET', apiKey: 'SECRET', raw_payload: 'SECRET',
  });
  const [payload] = await got;
  const flat = JSON.stringify(payload);
  assert.ok(!flat.includes('SECRET'), `payload leaked secrets: ${flat}`);
  c.close();
});

test('emitter rejects fabricated status transitions', () => {
  assert.equal(
    emitter.emitMessageStatus(ORG_A, { messageId: 'x', contactNumber: '1', status: 'teleported' }),
    false
  );
});

test('worker→socket boundary: job org determines the room, never globals', async () => {
  // Simulate the sendQueue worker path: validated job org → status emit.
  const a1 = connectClient(101);
  const b1 = connectClient(201);
  await Promise.all([waitFor(a1, 'connect'), waitFor(b1, 'connect')]);
  let aGot = false;
  let bGot = false;
  a1.on('message-status-update', () => { aGot = true; });
  b1.on('message-status-update', () => { bGot = true; });
  const jobOrg = ORG_A; // what tenantJobAllowed validated
  emitter.emitMessageStatus(jobOrg, { messageId: 'wamid-1', contactNumber: '1999', status: 'sent' });
  await sleep(300);
  assert.equal(aGot, true);
  assert.equal(bGot, false);
  a1.close();
  b1.close();
});
