# PHASE 7 — Socket.IO Forensic Report

Date: Phase 7 execution. Scope: pre-existing realtime implementation in Green Pilot (ForgeChat engine).

## Verdict

**No Socket.IO implementation existed.** Realtime was a single-process
Server-Sent Events (SSE) design plus polling. There was nothing to migrate —
only a room-naming convention to choose and an SSE path to supersede.

## Inventory (pre-Phase 7)

| Area | Finding | Location |
|---|---|---|
| Server init | None. No `socket.io` dependency, no `Server` construction | `backend/package.json`, `backend/src/index.js` |
| Client init | None. No `socket.io-client` dependency | `frontend/package.json` |
| Auth handshake | N/A — SSE reused the HTTP auth cookie via `EventSource('/api/events', { withCredentials: true })`, behind `authMiddleware` + `resolveTenant` | `backend/src/routes/events.js`, `frontend/src/hooks/useServerEvents.js` |
| Middleware | N/A | — |
| Connection lifecycle | SSE: one `EventSource` per chat-view mount; browser auto-reconnect (~3s); 25s `: ka` keepalive; cleanup removes bus listeners on `close`/`error` | `backend/src/routes/events.js:21-58` |
| Rooms | None. The legacy bus is process-global with **no tenant scoping** | `backend/src/events.js` |
| Event names (legacy bus) | `message-status`, `contact-saved`, `contact-assignment-changed`, `agent-handoff`, `agent-resumed` | `backend/src/services/agentHandoff.js`, `agentCrmTools.js`, `statusReconciler.js`, `routes/webhook.js:504` |
| SSE forwarded events | Only `message-status` (plus synthetic `hello`) | `backend/src/routes/events.js:19` |
| Emitters | `webhook.js` (status receipts after COMMIT), `statusReconciler.js` (healed ticks); handoff/CRM tools emit contact events nobody forwards to SSE | listed above |
| Listeners (frontend) | `ChatWindow.jsx` applied `message-status` ticks monotonically (`higherStatus`); nothing else consumed the stream | `frontend/src/components/ChatWindow.jsx:142-150` |
| Reconnect behavior | SSE only: `EventSource` native retry. HTTP re-auth per request (live role/`is_active` check). No socket concept | `backend/src/auth.js:94-135` |
| Disconnect handling | SSE `cleanup()` on `req close/error` | `backend/src/routes/events.js:52-56` |
| CORS | Explicit allowlist (`CORS_ORIGIN` + localhost/127.0.0.1 any-port); no wildcard. Socket path did not exist | `backend/src/index.js:48-89` |
| Namespaces | None | — |
| Redis adapter | None (single-process `EventEmitter`; comment notes a future Redis swap) | `backend/src/events.js:1-5` |
| Queue→realtime | None. Workers (`sendQueue`, `mediaQueue`, `agentQueue`) never emitted realtime events; outbound `sent`/`failed` transitions were poll-only | `backend/src/queue/*.js` |
| WhatsApp→realtime | Partial: only **status receipts** emitted (`message-status`, unscopped). **Inbound messages emitted nothing** — inbox discovery was poll-only | `backend/src/routes/webhook.js` |
| Frontend store | No realtime store. `usePolling` (15s messages, 30s contacts, 60s window-status) + `useServerEvents` (SSE ticks) | `frontend/src/hooks/` |

## Tenant-safety gaps in the legacy design (closed by Phase 7)

1. `backend/src/events.js` bus is **global** — any listener receives every
   tenant's `message-status`. Only the frontend's wa/contact filter (and the
   auth'd SSE stream) stood between tenants.
2. Inbound WhatsApp messages produced **zero** realtime signal.
3. Worker status transitions (`sent`/`failed`) produced **zero** realtime signal.
4. `agent-handoff` / `contact-*` bus events were emitted but never forwarded
   anywhere (dead signal for multi-member teams).

## Naming-convention decision

Phase 5 planning docs referenced rooms `org-{id}` (dash) and `org-${id}`, but
**no such rooms were ever implemented** (no Socket.IO existed), so there is no
legacy convention to migrate and no compat alias to maintain. Phase 7 adopts
the canonical **`org:{organizationId}`** (colon, per the Phase 7 brief) and
**`user:{userId}`**, enforced by validators (`isOrgRoom`/`isUserRoom`) in
`backend/src/realtime/socket.js`. The legacy SSE route is retained unchanged
as deprecated compat.

## Polling disposition

Pre-existing polling (`usePolling`) is **retained as the fallback** under the
live socket (it is the self-healing path the webhook code comments already
assume: "a missed push self-heals on the next 15s poll"). No new polling was
added; socket events only *accelerate* the same refetches.
