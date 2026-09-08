// Green Pilot canonical realtime client — one controlled Socket.IO connection
// per authenticated session (module singleton, so N components share it).
//
// Auth: the HttpOnly session cookie rides along automatically (same-origin in
// prod via nginx, vite proxy in dev) — no token is ever read into JS, stored,
// or sent in a payload. The server re-authenticates EVERY (re)connect from the
// cookie + organization_members; a forged organizationId from this client can
// never grant room access (the server ignores it).
//
// Defense in depth: events carry organizationId and are filtered against the
// active org (see api.getActiveOrgId) before dispatch — the server already
// scopes rooms, this just stops a stale-org tab from applying foreign state.

import { io } from 'socket.io-client';
import { getActiveOrgId } from '../api.js';

export const REALTIME_EVENTS = [
  'inbound-message',
  'message-status-update',
  'conversation-updated',
  'lead-qualified',
  // Extended org-scoped UI events (same tenant boundary).
  'contact-saved',
  'contact-assignment-changed',
  'agent-handoff',
  'agent-resumed',
];

const MAX_SEEN_IDS = 500;

let socket = null;
let status = 'disconnected'; // connected | disconnected | unauthorized | error
let activeOrgOverride = null; // test hook / explicit org pin
const statusListeners = new Set();
const eventListeners = new Map(); // event -> Set<handler>
const seenEventIds = [];

function currentOrgId() {
  if (activeOrgOverride) return activeOrgOverride;
  try { return getActiveOrgId(); } catch { return null; }
}

function setStatus(next) {
  if (status === next) return;
  status = next;
  for (const fn of [...statusListeners]) {
    try { fn(status); } catch { /* listener fault must not break the bus */ }
  }
}

function rememberEventId(id) {
  if (!id) return false; // no id → not dedupable, always dispatch
  if (seenEventIds.includes(id)) return true;
  seenEventIds.push(id);
  if (seenEventIds.length > MAX_SEEN_IDS) seenEventIds.shift();
  return false;
}

function dispatch(event, payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  // Tenant filter: when an org is active, drop events scoped to another org.
  // (Server rooms already enforce this; the filter covers org switches and
  // stale tabs.) Events without an organizationId are dispatched — legacy
  // compat — except the four canonical events, which MUST carry one.
  const canonical = REALTIME_EVENTS.slice(0, 4).includes(event);
  const org = currentOrgId();
  if (data.organizationId && org && String(data.organizationId) !== String(org)) return;
  if (canonical && !data.organizationId && org) return;
  if (data.eventId && rememberEventId(data.eventId)) return; // idempotent replay guard
  const handlers = eventListeners.get(event);
  if (!handlers) return;
  for (const fn of [...handlers]) {
    try { fn(data); } catch { /* isolate listener faults */ }
  }
}

function ensureSocket() {
  if (socket) return socket;
  socket = io({
    withCredentials: true,
    // Reconnect forever on transient loss (server restart, network blip);
    // every attempt re-sends the cookie and re-runs server-side auth, so a
    // deauthorized session can never silently regain org rooms.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
    timeout: 20000,
  });

  socket.on('connect', () => setStatus('connected'));
  socket.on('disconnect', () => setStatus('disconnected'));
  socket.on('connect_error', (err) => {
    const msg = String(err?.message || '');
    // Auth/session failures must NOT hot-loop: stop retrying and surface
    // `unauthorized` so the app can route to login. A fresh connect() after
    // login resumes normally.
    if (/auth|unauthorized|forbidden|not allowed by cors/i.test(msg)) {
      try { socket.disconnect(); } catch { /* ignore */ }
      setStatus('unauthorized');
    } else {
      setStatus('error');
    }
  });
  // Server-side safe errors (never stack traces / secrets).
  socket.on('error-message', () => { /* surfaced via status; payload ignored */ });

  for (const event of REALTIME_EVENTS) {
    socket.on(event, (payload) => dispatch(event, payload));
  }
  return socket;
}

export function connectRealtime() {
  const s = ensureSocket();
  if (!s.connected && status !== 'unauthorized') {
    try { s.connect(); } catch { /* connect_error handler reports */ }
  } else if (status === 'unauthorized') {
    // Explicit retry after re-login: clear the flag and dial again.
    setStatus('disconnected');
    try { s.connect(); } catch { /* ignore */ }
  }
  return s;
}

export function disconnectRealtime() {
  if (!socket) return;
  try { socket.disconnect(); } catch { /* ignore */ }
  setStatus('disconnected');
}

export function subscribeRealtime(event, handler) {
  if (typeof handler !== 'function') return () => {};
  let set = eventListeners.get(event);
  if (!set) { set = new Set(); eventListeners.set(event, set); }
  set.add(handler);
  return () => {
    const s = eventListeners.get(event);
    if (s) s.delete(handler);
  };
}

export function onRealtimeStatusChange(fn) {
  if (typeof fn !== 'function') return () => {};
  statusListeners.add(fn);
  return () => { statusListeners.delete(fn); };
}

export function getRealtimeStatus() {
  return status;
}

// Test-only helpers (reset module state between unit tests).
export function __resetRealtimeForTests() {
  try { socket?.disconnect(); } catch { /* ignore */ }
  try { socket?.removeAllListeners(); } catch { /* ignore */ }
  socket = null;
  status = 'disconnected';
  activeOrgOverride = null;
  eventListeners.clear();
  seenEventIds.length = 0;
  statusListeners.clear();
}

export function __setActiveOrgForTests(orgId) {
  activeOrgOverride = orgId;
}

// Test-only: inject a dispatch without a network socket.
export function __dispatchRealtimeForTests(event, payload) {
  dispatch(event, payload);
}
