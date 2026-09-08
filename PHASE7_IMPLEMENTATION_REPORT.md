# PHASE 7 — Implementation Report (Socket.IO Realtime & Tenant-Isolated Team Inbox)

## 1. Previous architecture (forensic summary)

No Socket.IO existed. Realtime was a process-global `EventEmitter` bus
(`backend/src/events.js`) + an SSE route forwarding **only** `message-status`
(`backend/src/routes/events.js`), plus polling (`usePolling`: 15s messages,
30s contacts). Inbound WhatsApp messages and worker `sent`/`failed`
transitions emitted nothing realtime. Full detail:
`PHASE7_SOCKET_FORENSIC_REPORT.md`.

## 2. Final architecture

```text
WhatsApp webhook ── HMAC + account-org ownership ── persist (stamped org)
      │                                              ├─ inbound-message ──► org:{id}
      │                                              └─ conversation-updated ─► org:{id}
      └─ status receipt advances row ── message-status-update ─► org:{id}

BullMQ worker ── tenantJobAllowed(jobOrg, accountOrg) ── markSent/markFailed
      └─ message-status-update (sent/failed) ─► org:{jobOrg}

HTTP routes (req.org, access-checked) ── conversation-updated ─► org:{id}
  (POST /messages/send, POST /messages/mark-read)

Socket.IO (same HTTP server) ── JWT (cookie|auth.token) ── live user check
      ── organization_members ── auto-join org:{id} rooms + user:{id}
Frontend singleton ── cookie auth ── org filter ── eventId dedupe
      ── ChatWindow (ticks + debounced refetch) / ContactList (debounced refetch)
```

New files: `backend/src/realtime/socket.js`, `backend/src/realtime/emitter.js`,
`backend/test/socketRealtime.test.js`, `frontend/src/realtime/socketClient.js`,
`frontend/src/hooks/useRealtime.js`,
`frontend/src/realtime/__tests__/socketClient.test.jsx`.
SSE route kept unchanged as deprecated compat. No Redis adapter (single-process,
same as before; rooms are server-local — documented limitation for a future
multi-instance step, which would add the adapter without changing contracts).

## 3. Authentication (§socket.js `authenticateHandshake`, `SocketAuthError`)

Token from `auth.token` else `forgecrm_token` cookie (same JWT as HTTP).
Verifies signature → requires `id`+`role` → **live** user row (`is_active`
re-checked, demotions apply instantly) → memberships from
`organization_members`. Failures emit the exact generic `Authentication failed`
(or `Authentication service unavailable`); reasons stay in server logs.
`join-org` **re-validates** the handshake live — reconnects re-authenticate by
construction (Socket.IO re-runs `io.use` middleware; no auth cache exists).

## 4. Room model

Canonical `org:{organizationId}` + `user:{userId}` (`orgRoom`/`userRoom`,
regex-validated). Members auto-join all their org rooms + own user room on
connect. `join-org` allows re-join after org changes (verified). Generic
`join` allows only held rooms. Memberless authenticated sockets connect with
zero org rooms (fail closed per-room). No client value ever authorizes a room.

## 5. Organization authorization

Single source: `organization_members` via `listUserOrganizations` (connect) /
fresh re-check (`join-org`). Forged `organizationId`, arbitrary room names,
client roles, and client identities are all ignored-or-rejected (tests 7–11).

## 6. Event contracts

Four canonical + four extended org-scoped events; full payload/authorization/
idempotency tables in `PHASE7_SOCKET_EVENT_CONTRACT.md`. Emitter rules:
explicit org required (throws), unknown events rejected, statuses validated,
banned keys stripped.

## 7. Inbound WhatsApp → socket (`routes/webhook.js`)

After COMMIT: per persisted row with resolved org → `inbound-message` +
`conversation-updated` to that org only. Status receipts: org from the updated
row (query now `RETURNING organization_id`), else the v1 route org; org-less
rows stay SSE-only. Never global, never client-derived.

## 8. Message-status flow

`PENDING(sending)` (optimistic row + teammate `inbound-message`
`direction:outgoing`), `SENT` (worker, job org), `DELIVERED/READ/FAILED`
(webhook receipt, row org), healed ticks (reconciler, row org), terminal
`FAILED` (worker, job org). Frontend applies ticks monotonically and refetches
(debounced). No transition is fabricated (`emitMessageStatus` drops unknowns).

## 9. Conversation flow

Webhook (per message), teammate send, and mark-read (`unreadCount: 0`) emit
`conversation-updated`. `ContactList` refetches debounced/coalesced (800ms).

## 10. Qualification event preparation

`emitLeadQualified` + contract exist; **zero production callers** (no engine,
no credits, no AI). Payload is ids + refresh hints only.

## 11. Frontend integration

Singleton `socketClient.js` (one connection per tab/session) + `useRealtime`
hook. `ChatWindow` and `ContactList` consume; `App.jsx` logout calls
`disconnectRealtime()`. Existing polling retained as fallback; SSE hook
retained as compat. No UI redesign.

## 12. Reconnect behavior

Infinite backoff reconnect (1s→30s, jittered); every attempt re-sends the
cookie and re-runs full server auth. Auth failures disconnect and surface
`unauthorized` (no hot-loop); post-login `connectRealtime()` redials.

## 13. CORS

Socket.IO reuses the explicit HTTP policy (`CORS_ORIGIN` + new optional
`CORS_ORIGINS` comma list + localhost/loopback any-port for local installs).
No wildcard. Origin callback rejects anything else. `secure` cookies +
`sameSite=strict` unchanged.

## 14. Worker integration

`queue/sendQueue.js`: after the existing `tenantJobAllowed` gate, `sent` and
terminal `failed` emit with `job.organizationId` only. Missing org → no emit
(fail closed). Org is threaded, never read from globals/last-job/defaults.

## 15. Security

Handshake auth, live membership validation, room authorization, explicit CORS,
no client tenant trust, sanitized payloads (test-proven), safe errors
(test-proven exact string), reconnect re-auth, per-event isolation
(test-proven ×4 + symmetry), secrets never in payloads. No advertising, billing,
or AI code touched.

## 16. Tests — backend 70/70, frontend 63/63 (detail: `PHASE7_TENANT_REALTIME_TEST_REPORT.md`)

## 17. Builds

`tsc --noEmit` ✅ (realtime added to checked surface) · `eslint` ✅ ·
`node --check` (new/touched) ✅ · `vite build` ✅ · backend has no bundle step
(plain JS; CI equivalents all green).

## 18. Remaining warnings / known limitations

1. Single-process rooms (no Redis adapter) — multi-instance deploy would need
   `@socket.io/redis-adapter`; contracts unchanged when that lands.
2. `vite build` chunk-size note is pre-existing (bundle grew ~2KB gz).
3. SSE route + polling retained as compat/fallback (intentional, not debt to
   hide): removal is a later cutover decision.
4. `lead-qualified` has no producer yet (by design — Stage 3).
5. `CORS_ORIGINS` (plural) is new — document in deploy env when used.

---

**PHASE 7 STATUS: COMPLETE**
