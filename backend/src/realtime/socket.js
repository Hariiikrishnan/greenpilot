// Green Pilot canonical realtime transport — Socket.IO server.
//
// Chain (mirrors the HTTP tenant middleware):
//   socket handshake → verify JWT (who) → load memberships (which orgs)
//   → join ONLY server-authorized rooms.
//
// Rules (Phase 7 hard stops):
//   1. The organization context ALWAYS derives from organization_members —
//      never from a client-supplied organizationId, room name, role, or identity.
//   2. Rooms are canonical: `org:{organizationId}` and `user:{userId}`.
//      Any other room request is rejected.
//   3. Reconnects re-run the full handshake (no cached authorization).
//   4. Errors to the client are generic; diagnostics stay server-side.
//   5. CORS is explicit — no wildcard in production.
//
// The legacy SSE bus (events.js) is kept as a deprecated compat forwarder;
// Socket.IO rooms are canonical. See PHASE7_SOCKET_EVENT_CONTRACT.md.

const { Server } = require('socket.io');

const COOKIE_NAME = 'forgecrm_token';

// Canonical room naming. `org-{id}` (dash) appeared in Phase 5 planning docs
// but was never implemented (no Socket.IO existed); `org:{id}` (colon) is the
// implemented canonical form. There is nothing to migrate — no compat alias.
function orgRoom(organizationId) {
  return `org:${String(organizationId)}`;
}

function userRoom(userId) {
  return `user:${String(userId)}`;
}

function isOrgRoom(name) {
  return typeof name === 'string' && /^org:[A-Za-z0-9-]+$/.test(name);
}

function isUserRoom(name) {
  return typeof name === 'string' && /^user:\d+$/.test(name);
}

function orgIdFromRoom(room) {
  return room.slice('org:'.length);
}

// Minimal cookie parser for the handshake (avoids pulling express middleware
// into the socket path). Handles `a=b; c=d` pairs; values are URI-decoded
// best-effort.
function parseCookieHeader(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    let val = part.slice(idx + 1).trim();
    try { val = decodeURIComponent(val); } catch { /* keep raw */ }
    if (key) out[key] = val;
  }
  return out;
}

// Token resolution order: explicit auth.token (native/mobile clients) first,
// then the HttpOnly session cookie (browser clients). Both carry the SAME JWT
// the HTTP API uses — no second credential, no client-supplied identity.
function tokenFromHandshake(handshake) {
  const viaAuth = handshake?.auth?.token;
  if (typeof viaAuth === 'string' && viaAuth.length > 0) return viaAuth;
  const cookies = parseCookieHeader(handshake?.headers?.cookie);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  return null;
}

function jwtSecret() {
  return process.env.JWT_SECRET || 'forgecrm-dev-secret-change-me';
}

function verifySocketToken(token) {
  const jwt = require('jsonwebtoken');
  return jwt.verify(token, jwtSecret());
}

// Default production dependencies (overridable via initRealtime opts so tests
// can inject fakes without a database).
function defaultDeps() {
  const pool = require('../db');
  const { listUserOrganizations } = require('../tenancy/organizations');
  return {
    // Returns [{ organization_id|id, ... }] for the user.
    listOrgs: (userId) => listUserOrganizations(pool, userId),
    // Returns the live user row or null. Must reflect deactivation/demotion
    // immediately (same rule as the HTTP authMiddleware).
    loadUser: async (userId) => {
      const { rows } = await pool.query(
        'SELECT id, role, is_active FROM coexistence.forgecrm_users WHERE id = $1',
        [userId]
      );
      return rows[0] || null;
    },
    log: (...args) => console.error(...args),
  };
}

// Client-visible socket errors carry a machine code alongside the generic
// message (the message stays safe; the code lets the client branch without
// parsing text). Server-side logs keep the detailed reason.
class SocketAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SocketAuthError';
    this.code = code;
  }
}

// Authenticate one handshake. Returns { userId, role, orgIds } or throws a
// SAFE error (message is client-visible, so it must stay generic). Detailed
// reasons are logged server-side by the caller.
async function authenticateHandshake(handshake, deps) {
  const token = tokenFromHandshake(handshake);
  if (!token) {
    throw new SocketAuthError('Authentication failed', 'socket-unauthorized');
  }
  let payload;
  try {
    payload = verifySocketToken(token);
  } catch {
    throw new SocketAuthError('Authentication failed', 'socket-unauthorized');
  }
  if (!payload || !payload.id || !payload.role) {
    throw new SocketAuthError('Authentication failed', 'socket-unauthorized');
  }
  let liveUser = null;
  try {
    liveUser = await deps.loadUser(payload.id);
  } catch (dbErr) {
    deps.log('[socket] auth user lookup failed:', dbErr.message);
    throw new SocketAuthError('Authentication service unavailable', 'socket-unavailable');
  }
  if (!liveUser) {
    throw new SocketAuthError('Authentication failed', 'socket-unauthorized');
  }
  if (liveUser.is_active === false) {
    throw new SocketAuthError('Authentication failed', 'socket-forbidden');
  }
  let memberships = [];
  try {
    memberships = await deps.listOrgs(payload.id);
  } catch (dbErr) {
    // Pre-tenancy databases (migrations not yet applied): same transient rule
    // as the HTTP resolveTenant — proceed with zero orgs, join nothing.
    if (dbErr && dbErr.code === '42P01') {
      deps.log('[socket] membership table missing (pre-migration) — no org rooms');
      memberships = [];
    } else {
      deps.log('[socket] auth membership lookup failed:', dbErr.message);
      throw new SocketAuthError('Authentication service unavailable', 'socket-unavailable');
    }
  }
  const orgIds = [];
  for (const m of memberships || []) {
    const id = m.organization_id || m.id;
    if (id) orgIds.push(String(id));
  }
  // Non-members may still connect (they get their user room only, no org
  // rooms, no events) — EXCEPT the HTTP API fails closed with 403 for
  // tenant-sensitive routes. Sockets fail closed per-ROOM instead: a socket
  // with no memberships simply belongs to zero org rooms and every join-org
  // attempt is rejected. Emitters additionally require an explicit org, so a
  // memberless socket can never receive tenant data.
  return { userId: String(payload.id), role: liveUser.role, orgIds };
}

let ioSingleton = null;

function getIO() {
  return ioSingleton;
}

// Shared CORS origin check (same policy as the HTTP API): explicit
// CORS_ORIGIN(S) plus any localhost/127.0.0.1 origin for local installs.
// NEVER a wildcard in production — a missing origin (native clients, curl)
// is allowed to complete the HTTP handshake but still must authenticate.
function buildCorsOrigin() {
  const extra = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = [process.env.CORS_ORIGIN, ...extra, 'http://localhost:5173'].filter(Boolean);
  const isLocalOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o || '');
  return (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowed.includes(origin) || isLocalOrigin(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  };
}

function initRealtime(httpServer, opts = {}) {
  if (ioSingleton) return ioSingleton;
  const deps = { ...defaultDeps(), ...(opts.deps || {}) };

  const io = new Server(httpServer, {
    cors: { origin: buildCorsOrigin(), credentials: true },
    serveClient: false,
    // Path default (/socket.io) — kept so the frontend needs no custom config.
  });

  // Handshake authentication — runs on EVERY (re)connect. socket.io re-runs
  // `io.use` middleware after a reconnect by design; we keep no authorization
  // cache anywhere, so a demoted/removed member loses org rooms on next dial.
  io.use(async (socket, next) => {
    try {
      const identity = await authenticateHandshake(socket.handshake, deps);
      socket.data.identity = identity;
      next();
    } catch (err) {
      deps.log(
        `[socket] rejected handshake from ${socket.handshake?.address || 'unknown'}: ${err.code || 'socket-unauthorized'}`
      );
      next(err);
    }
  });

  io.on('connection', (socket) => {
    const identity = socket.data.identity || { userId: 'unknown', role: '?', orgIds: [] };
    const memberRooms = new Set(identity.orgIds.map(orgRoom));

    // Server-authorized joins only: every org room comes from the verified
    // membership list, plus the caller's own user room. Nothing client-derived.
    for (const room of memberRooms) {
      try { socket.join(room); } catch { /* join failure — socket stays roomless */ }
    }
    try { socket.join(userRoom(identity.userId)); } catch { /* ignore */ }

    // Explicit re-join request (e.g. after the user is added to a new org):
    // membership is RE-VALIDATED live — a forged organizationId is rejected.
    socket.on('join-org', async (requestedOrgId, ack) => {
      const respond = (payload) => { if (typeof ack === 'function') { try { ack(payload); } catch { /* ignore */ } } };
      try {
        const fresh = await authenticateHandshake(socket.handshake, deps);
        socket.data.identity = fresh;
        const wanted = String(requestedOrgId || '');
        if (!wanted || !fresh.orgIds.includes(wanted)) {
          socket.emit('error-message', { code: 'not-member', message: 'Not authorized for this organization' });
          return respond({ ok: false, code: 'not-member' });
        }
        await socket.join(orgRoom(wanted));
        return respond({ ok: true, room: orgRoom(wanted) });
      } catch {
        socket.emit('error-message', { code: 'unauthorized', message: 'Authentication failed' });
        return respond({ ok: false, code: 'unauthorized' });
      }
    });

    // Generic join guard: the ONLY rooms a client may ever request are its own
    // user room or a membership-verified org room. Everything else is rejected
    // (prevents room-name probing / cross-tenant joins). Membership is
    // re-validated LIVE on every request (Phase 13) — a member removed or
    // demoted since connect cannot (re)join the revoked room.
    socket.on('join', async (room, ack) => {
      const respond = (payload) => { if (typeof ack === 'function') { try { ack(payload); } catch { /* ignore */ } } };
      try {
        const fresh = await authenticateHandshake(socket.handshake, deps);
        socket.data.identity = fresh;
        const wanted = String(room || '');
        const freshRooms = new Set(fresh.orgIds.map(orgRoom));
        if (wanted === userRoom(fresh.userId) || freshRooms.has(wanted)) {
          try { await socket.join(wanted); } catch { /* ignore */ }
          return respond({ ok: true, room: wanted });
        }
      } catch {
        socket.emit('error-message', { code: 'unauthorized', message: 'Authentication failed' });
        return respond({ ok: false, code: 'unauthorized' });
      }
      socket.emit('error-message', { code: 'forbidden-room', message: 'Not authorized for this room' });
      return respond({ ok: false, code: 'forbidden-room' });
    });

    socket.on('disconnect', (reason) => {
      deps.log(`[socket] user ${identity.userId} disconnected (${reason})`);
    });
    socket.on('error', () => { /* client-visible errors go via error-message */ });
  });

  ioSingleton = io;
  return io;
}

async function closeRealtime() {
  if (!ioSingleton) return;
  const io = ioSingleton;
  ioSingleton = null;
  try {
    await io.close();
  } catch { /* already closed */ }
}

// Test-only: drop the singleton without closing (lets each test init fresh).
function resetRealtimeForTests() {
  ioSingleton = null;
}

module.exports = {
  COOKIE_NAME,
  SocketAuthError,
  orgRoom,
  userRoom,
  isOrgRoom,
  isUserRoom,
  orgIdFromRoom,
  parseCookieHeader,
  tokenFromHandshake,
  authenticateHandshake,
  buildCorsOrigin,
  initRealtime,
  getIO,
  closeRealtime,
  resetRealtimeForTests,
};
