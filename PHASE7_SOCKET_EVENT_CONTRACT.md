# PHASE 7 — Socket.IO Event Contract (canonical)

Transport: Socket.IO rooms on the same HTTP server (`/socket.io` path).
Room model: `org:{organizationId}` (team room, auto-joined from verified
memberships) and `user:{userId}` (personal room). Every event below targets
exactly one `org:{id}` room and carries `organizationId`. No global emits.

Conventions for ALL events:

- `organizationId` (string, required) — the ONLY tenant routing key, always
  server-supplied. Clients must ignore events whose `organizationId` does not
  match the active org (defense in depth; rooms already enforce it).
- `eventId` (string) — idempotency key. Consumers dedupe on it (bounded LRU);
  re-delivery after reconnect must not double-apply.
- `timestamp` / qualified-at times are ISO-8601 strings.
- Phone numbers are digits-only strings.
- Payloads NEVER contain: tokens, secrets, passwords, API keys, raw Meta
  payloads, request headers, or AI prompts/model internals. Emitters strip
  banned keys defensively (`sanitizeBase` in `backend/src/realtime/emitter.js`).
- Unknown event names are rejected server-side (`emitToOrg` throws).
- Status values are validated against the lifecycle
  (`sending→sent→delivered→read/played`, plus `failed`/`received`);
  fabricated transitions are dropped, never emitted.

## 1. `inbound-message`

| | |
|---|---|
| Emitter | `emitInboundMessage(orgId, record)` — `backend/src/realtime/emitter.js`; called from `routes/webhook.js` after COMMIT (each persisted chat row with a resolved org) and from `routes/messages.js` `POST /messages/send` (outbound optimistic row, `direction: 'outgoing'`, `status: 'sending'`, so teammates see it) |
| Payload | `{ organizationId, eventId, messageId, waNumber, contactNumber, direction, messageType, body (≤4000 chars), status, timestamp, contextMessageId }` |
| Auth assumption | Webhook path: Meta HMAC + per-account org ownership (pre-existing). HTTP path: `assertContactAccess` + `req.org`. Org is the row's stamped org, never client input. |
| Frontend consumer | `ChatWindow` (`inbound-message` for the open conversation → debounced refetch); `ContactList` (any → debounced list refetch) |
| Idempotency | `eventId = 'inbound-{message_id}'`; duplicate webhook delivery upserts (`ON CONFLICT DO NOTHING`-equivalent) and re-emits are deduped client-side |

## 2. `message-status-update`

| | |
|---|---|
| Emitter | `emitMessageStatus(orgId, status)` — called from `routes/webhook.js` (receipt advanced a row; org from the row, else the v1 route org), `queue/sendQueue.js` worker (`sent` on success / `failed` on terminal failure; org = validated `job.organizationId`), `services/statusReconciler.js` (healed ticks; org = row's stamped org). Legacy SSE alias `message-status` preserved |
| Payload | `{ organizationId, eventId, messageId, waNumber, contactNumber, status, timestamp }`. Worker emits omit `waNumber` (only the recipient is known at that layer) — consumers match on `contactNumber`/`messageId` |
| Auth assumption | Each source holds a tenant-validated org (webhook ownership, `tenantJobAllowed`, row stamp). No org → no socket emit (fail closed, SSE/poll cover) |
| Frontend consumer | `ChatWindow` — monotonic tick override (`higherStatus`) + debounced refetch |
| Idempotency | `eventId = 'status-{messageId}-{status}'`; ticks apply monotonically only |

## 3. `conversation-updated`

| | |
|---|---|
| Emitter | `emitConversationUpdated(orgId, conv)` — called from `routes/webhook.js` (per persisted message, org = thread org), `routes/messages.js` `POST /messages/send` (teammate outbound) and `POST /messages/mark-read` (`unreadCount: 0` so teammates clear the badge) |
| Payload | `{ organizationId, eventId, waNumber, contactNumber, lastMessageAt, unreadCount (number|null — null = "refetch counts, hint only"), assignment, conversationStatus, lastMessagePreview (≤280 chars) }` |
| Auth assumption | Request/v1-webhook org context, pre-validated |
| Frontend consumer | `ContactList` (debounced refetch). ChatWindow ignores it (message-level events cover the open thread) |
| Idempotency | `eventId = 'conv-{contactNumber}-{now}'` (hint semantics — safe to coalesce) |

## 4. `lead-qualified` (contract only — no engine in this phase)

| | |
|---|---|
| Emitter | `emitLeadQualified(orgId, q)` — **no production caller yet**. Reserved for the Stage 3 AI/qualification phase |
| Payload | `{ organizationId, eventId, contactNumber, waNumber, leadId, conversationId, qualified (bool), qualifiedAt }`. Deliberately minimal: ids + refresh hints. NO score internals, prompts, model names, or reasoning |
| Auth assumption | Future caller must hold the account's validated org (same rule as `agentRouter`: account org must equal context org) |
| Frontend consumer | `useRealtime` forwards it today (no dedicated UI yet); the future inbox/lead view will refetch lead + conversation state on receipt |
| Idempotency | `eventId = 'leadq-{contactNumber}-{now}'` |

## Extended org-scoped UI events (preserved, same boundary)

`contact-saved`, `contact-assignment-changed`, `agent-handoff`, `agent-resumed`
— payload `{ organizationId, waNumber, contactNumber, …ids only }`. Emitted via
`emitToOrg` only (tenant-required). The legacy bus still carries the unscoped
originals for in-process consumers; they are NOT forwarded to SSE.

## Client→server messages (requests, not tenant signals)

- `join-org <organizationId>` → ack `{ ok, room? , code? }`. Membership is
  **re-validated live** from `organization_members`; forged ids get
  `{ ok:false, code:'not-member' }` + `error-message`. Never grants access.
- `join <room>` → allowed ONLY for the caller's own `user:{id}` room or an
  already-held `org:{id}` room; everything else
  `{ ok:false, code:'forbidden-room' }`.
- `error-message { code, message }` (server→client) — generic strings only.
