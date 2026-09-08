# PHASE 4 — Engine Adoption Map (ForgeChat → Green Pilot)

> Status: **FORENSIC INVENTORY + ADOPTION DECISIONS — NO IMPLEMENTATION CODE WRITTEN.**
> Date: 2026-09-04. Author: principal engineer (automated session).
> Scope rule (§2): WhatsApp CRM + AI lead qualification + team inbox + automation + CRM
> pipeline only. **No advertising functionality is adopted, migrated, or referenced.**
> Verified by repo-wide search: zero matches for `roas`, `cac`, `ad attribution`,
> `google ads`, `meta ads`, `ad campaign`, `ad spend` in `backend/src`, `frontend/src`,
> `mcp-server/src`.

## 0. Foundational finding (blocks implementation — see §25 hard stops)

The working tree `D:\dev project\GreenPilot` **is the ForgeChat engine itself**
(single-owner product, Express 4, raw `pg` SQL against the `coexistence` schema,
Vite + React 18 frontend, SSE realtime). The Green Pilot SaaS target described in
Phase 4 §3 (Express 5, TypeScript, Prisma/PostgreSQL, `/api/v1` contract, JWT +
organization-based tenancy, Next.js App Router + React 19 + Zustand, Socket.io,
`QualificationService`, `useChatStore`, billing/analytics architectures) **does not
exist anywhere in this workspace**:

- `organizationId` / `orgId` / `tenant`: zero matches in `backend/src`.
- `socket.io` / `QualificationService` / `useChatStore` / `zustand` / `prisma` /
  `next`: zero matches in `backend` + `frontend`.
- Realtime is `backend/src/events.js` (process-local `EventEmitter`) + SSE route
  `backend/src/routes/events.js` — not Socket.io.
- Backend `package.json`: `express@^4.19.2`, plain JS (no TypeScript), no Prisma.
- Frontend `package.json`: `react@^18.3.1`, Vite SPA (no Next.js).

And the engine license (`LICENSE.md`, Sustainable Use License v1.0, licensor
Forgemind Techhub LLP) states: *"You may not alter … Any use … for … paid hosting
as a service without permission"* — paraphrased precisely: use/modify only for own
internal business, non-commercial, or personal use; **no reselling or paid hosting
as a service without permission**. Re-platforming this engine as commercial B2B
SaaS (Green Pilot) therefore triggers **hard-stop condition #1** (license
restrictions prevent commercial SaaS use) plus **#5/#6** (adoption would require
replacing authentication and the API contract, since the target does not exist).

**Consequence:** per §25, implementation STOPS after the planning artefacts
(this map, the migration proposal, the implementation report). No code was
changed, no migration was executed. All ADOPT/ADAPT rows below are therefore
**conditional decisions — effective only after (a) a commercial license exception
is obtained and (b) the Green Pilot SaaS target (or an explicit decision to
evolve this codebase into it) is approved.**

## 1. Decision table

| ForgeChat Module | Green Pilot Action |
| ---------------- | ------------------ |
| WhatsApp webhook verification (GET challenge + POST HMAC) | ADOPT (harden) |
| Webhook payload parsing / normalization (`parseMetaPayload`) | ADOPT |
| Inbound message persistence + dedupe + status-monotonic update | ADOPT |
| Outbound WhatsApp sending (`metaSend.js` + `messageSender.js`) | ADOPT |
| BullMQ send queue + worker (`queue/sendQueue.js`) | ADOPT |
| BullMQ media queue + worker (`queue/mediaQueue.js` + `services/mediaDownloader.js`) | ADOPT |
| BullMQ agent queue + worker (`queue/agentQueue.js`) | ADOPT / ADAPT (credit + tenant gates) |
| AI agent engine (`engine/agentEngine.js` + `services/agentRouter.js` + `services/agentService.js`) | ADAPT (tenant scope + credit safety + service-layer tools) |
| AI CRM tools (`services/agentCrmTools.js`: set name, tag, custom field + sheets/HTTP/media tools) | ADAPT (re-scope to org + lead model; add status/note/assign/follow-up tools) |
| Qualification capability (MISSING — no `QualificationService` exists) | BUILD NEW (no ForgeChat source to adopt) |
| Automation engine (`engine/automationEngine.js` + `routes/chatbots.js`) | ADOPT / ADAPT (restore condition/delay/action nodes; add Green Pilot triggers/actions) |
| Media handling (`integrations/metaMedia.js`, `metaResumableUpload.js`, `services/transcription.js`) | ADOPT (as required) |
| Templates (`integrations/metaTemplates.js` + `services/templateComponents.js` + `routes/templates.js`) | ADOPT |
| Phone-number/WABA handling (`routes/whatsappAccounts.js`, AES-256-GCM token crypto) | ADAPT (per-organization accounts; remove single-account cap) |
| MCP (`routes/mcp.js` + `mcpHttp.js` + `services/mcpService.js` + `mcp-server/`) | SELECTIVE ADOPTION (agent CRUD + discovery only) |
| Realtime (`events.js` + `routes/events.js`, SSE) | ADAPT (replace with tenant-scoped Socket.io rooms `org-${organizationId}`) |
| Delivery-status reconciliation (`services/statusReconciler.js` + webhook audit `webhook_events`) | ADOPT |
| Account health (`services/accountHealth.js`) | ADOPT |
| Agent handoff / close-summary (`services/agentHandoff.js`, `agentCloseSummary.js`) | ADAPT (persist AI on/off per conversation) |
| Google Sheets / Google OAuth (`services/googleSheets.js`, `googleAuth.js`, `routes/googleIntegrations.js`) | SELECTIVE ADOPTION (Sheets tools only; not ads) |
| Advertising modules (Meta/Google Ads, attribution, CAC/ROAS, ad ROI) | EXCLUDE — do not exist in source; must never be added under Phase 4 |
| ForgeChat UI / branding / landing / pricing | DO NOT MIGRATE |

## 2. Per-decision detail

### 2.1 WhatsApp webhook verification — ADOPT (harden)
- Source files: `backend/src/routes/webhook.js` (GET `/webhook/whatsapp`, POST
  `/webhook/whatsapp`), `backend/src/util/webhookSignature.js`
  (`verifyMetaSignature`, `safeEqual`).
- Verified behavior: GET validates `hub.mode=subscribe` + per-account
  `verify_token_encrypted` (constant-time compare) with `META_WEBHOOK_VERIFY_TOKEN`
  env fallback; challenge echoed as `text/plain`. POST verifies
  `X-Hub-Signature-256` HMAC-SHA256 against `req.rawBody` (raw bytes captured via
  `express.json({ verify })` in `index.js`); invalid → `403`; processing happens
  only after verification.
- **Gap vs §7:** when `META_APP_SECRET` is unset, `verifyMetaSignature` returns
  `null` and the handler only **warns** and processes anyway. Green Pilot adapter:
  require the secret per-organization (stored encrypted alongside the WhatsApp
  account) and **reject unverifiable webhooks**; never run in warn-only mode in
  production. Tenant resolution: resolve account by `phone_number_id` from payload
  metadata → organization; scope all writes to that org.
- Dependencies: `pg` pool, `util/crypto.js` (decrypt), Node `crypto`. Env:
  `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` (transitional fallback only).
- Queue/API/tenant: none yet (must add org resolution). Migration: none for the
  verification itself; org-scoping needs proposal §4 of the migration doc.

### 2.2 Payload parsing / normalization — ADOPT
- Source: `parseMetaPayload()` in `backend/src/routes/webhook.js` (~190 lines).
  Handles text, image, video, audio/voice, document, sticker, location, contacts,
  interactive (button/list replies), reaction (attached, not a bubble), order,
  system, unknown/error, `message_echoes`, and `statuses`. Digits-only phone
  normalization prevents duplicate threads.
- Green Pilot adapter: new module `backend/src/whatsapp/normalizeMeta.js` (TS)
  producing the canonical internal message DTO; never expose `raw_payload` to the
  frontend (currently stored per-row — keep server-side only).
- No new env/queue deps. Tenant: caller must stamp `organizationId`.

### 2.3 Inbound persistence, dedupe, status monotonicity — ADOPT
- Source: POST handler in `routes/webhook.js` + `STATUS_RANK` guard
  (`sending 0 < sent 1 < delivered/failed 2 < read/played 3`; updates only advance),
  `ON CONFLICT (message_id) DO UPDATE` dedupe, reaction upsert/delete,
  contact profile upsert (writes `profile_name`, never clobbers captured `name`),
  backfill of blank `display_phone_number` keyed on stable `phone_number_id`,
  audit table `coexistence.webhook_events` (`logWebhookReceived/Processed`).
- Green Pilot adapter: `POST /api/v1/webhooks/whatsapp/:orgId` with idempotent
  processing on Meta `message_id`; conversation lookup/create
  (`lastMessageAt`, `unreadCount`); tenant-scoped lead lookup/create by phone.
- DB: needs `Conversation`/`Message`/lead indexes — see migration proposal (NOT executed).

### 2.4 Outbound sending + BullMQ send queue — ADOPT
- Sources: `backend/src/integrations/metaSend.js` (Meta Graph API calls),
  `backend/src/services/messageSender.js` (optimistic `sending` row → enqueue →
  worker swaps in real wamid / marks `failed` with `error_message`),
  `backend/src/queue/sendQueue.js` (queue `forgecrm-send`, concurrency 5,
  attempts 4, 60 msg/s rate limit under Meta Tier-1 80/s ceiling, graceful drain
  on SIGTERM/SIGINT in `index.js`).
- Flow matches §10 exactly: API persists PENDING → BullMQ → worker → Meta →
  status update. Green Pilot adapter: keep, add `organizationId` to job data and
  resolve credentials per-org (never a global singleton).
- Env: `REDIS_URL`, `SEND_QUEUE_CONCURRENCY`, `SEND_RATE_MAX`,
  `SEND_RATE_DURATION_MS`, `SEND_QUEUE_ATTEMPTS`, `META_API_VERSION`.

### 2.5 Media queue + downloader — ADOPT
- Sources: `backend/src/queue/mediaQueue.js`, `backend/src/services/mediaDownloader.js`
  (`markPending`, `MEDIA_TYPES`), `integrations/metaMedia.js`,
  `integrations/metaResumableUpload.js`, `util/metaMime.js`, `util/pgStorage.js`.
- Behavior: webhook marks media `pending` and enqueues durable download
  (concurrency-capped + retried); audio transcoding (`ffmpeg` Ogg/Opus) and voice
  transcription (`services/transcription.js`, OpenAI) feed the agent.
- Adopt as-is behind org-scoped storage paths.

### 2.6 Agent queue + worker — ADOPT / ADAPT
- Source: `backend/src/queue/agentQueue.js` (queue `forgechat-agent`, concurrency 4,
  attempts 2; per-contact serial processing; runs `runAgent` off the 20 s Meta
  webhook ceiling).
- Adaptations required: per-`(organizationId, contact)` serialization key,
  pre-execution credit/quota check (§14), idempotency key on
  `(organizationId, inboundMessageId)` to block webhook-retry double execution.

### 2.7 AI agent engine — ADAPT
- Sources: `backend/src/engine/agentEngine.js` (LLM tool-use loop),
  `backend/src/services/agentRouter.js` (precedence: resume paused automation →
  keyword automation → active agent; one-active-agent-per-account partial unique
  index), `backend/src/services/agentService.js`, `backend/src/llm/` (OpenAI +
  Anthropic providers), `backend/src/routes/agents.js` + `agentConversation.js` +
  `aiModels.js` (builder, preview, run history).
- Constraints already enforced and to keep: OpenAI/Anthropic only, context window
  1–100, max tool iterations 1–20, trigger session 1–1440 min, vision gate for
  `acceptImages`, transcription gate for audio.
- Adaptations: resolve `organizationId` first; enforce AI quota before `runAgent`;
  record usage; tool executors must call shared service-layer functions with an
  org-scoped context (never cross-tenant lead/account access); structured
  qualification output must leave unconfident fields `null` (§12).

### 2.8 AI CRM tools — ADAPT
- Source: `backend/src/services/agentCrmTools.js` — executors scoped to a single
  `(wa_number, contact_number)`: `set_contact_name`, `add_contact_tag` (existing
  tags only), `set_contact_field` (defined fields only) + sheet/HTTP/media tools
  wired in `agentEngine.js`.
- Gap vs §15: no update-status / add-note / assign-lead / schedule-follow-up /
  log-call / conversation-history tools exist. These must be **built new** against
  Green Pilot's lead services with `(organizationId, entityId)` ownership checks
  on every call. Current `(wa_number, contact_number)` scoping pattern is the
  correct model to extend — never raw lead IDs from the model.

### 2.9 Qualification — BUILD NEW (nothing to adopt)
- Forensic result: no qualification module, no scoring, no `QualificationService`
  exists in this tree. The agent's ask-name flow and CRM write-back are the
  closest relatives but are not lead qualification.
- Green Pilot must build `QualificationService` new per §12 flow (conversation
  state → model → structured result → score/status/timeline → conditional reply),
  with anti-fabrication (`null` when unconfident), credit safety, and
  idempotency. No ForgeChat file maps to this row.

### 2.10 Automation engine — ADOPT / ADAPT
- Sources: `backend/src/engine/automationEngine.js` (1416 lines; trigger matching,
  `{{variable}}` interpolation, execution + step logging, pause/resume with
  expiry sweeper in `index.js`), `backend/src/routes/chatbots.js`
  (`sanitizeToLinear` + keyword triggers), `components/AutomationBuilderView.jsx`.
- Current product scope is **keyword trigger + linear send-message only**
  (SESSION-HANDOFF.md); condition/delay/action/handoff/AI/API/subflow handlers
  are parked dead code retained by operator choice.
- Green Pilot (§16) needs Trigger → Condition → Action → Delay → Condition →
  Action with triggers (lead created, inbound message, lead qualified, status
  changed, follow-up due) and actions (send WhatsApp, update status, add note,
  assign, schedule follow-up, invoke AI). Adopt the runner, logging, pause/resume,
  and sweepers; re-enable/extend node handlers behind the new trigger/action
  catalogue. Delayed jobs ride BullMQ with the same retry/backoff conventions.

### 2.11 Templates + WABA handling — ADOPT / ADAPT
- Sources: `integrations/metaTemplates.js`, `services/templateComponents.js`,
  `routes/templates.js` (submit-to-Meta, approval polling every 10 min gated on
  pending count), `routes/whatsappAccounts.js` (AES-256-GCM token encryption via
  `util/crypto.js` + `util/instanceSecrets.js`, single-account cap returning 409,
  `getAccountWithToken`/`getAccountByPhoneNumber`/`getSingleAccount`).
- Adaptations: **remove the single-account cap**; accounts become
  organization-owned (`organizationId` FK); credential resolution per-org per-job;
  keep encryption + `display_phone_number` auto-detect/backfill.

### 2.12 MCP — SELECTIVE ADOPTION
- Sources: `backend/src/routes/mcp.js` (+ `ensureMcpTables`, migration `057_mcp.sql`),
  `backend/src/mcpHttp.js` (`/api/mcp/http/:key`), `backend/src/services/mcpService.js`,
  `mcp-server/` (Claude connector), Admin Settings → MCP Tools UI (master switch +
  per-capability gates, `fck_live_…` keys).
- Adopt: discovery tools (`list_wa_accounts`, `list_models`, `list_media`,
  `list_templates`, `list_agents`) + agent CRUD under capability gates, re-scoped
  per-organization. Exclude: anything not required by Green Pilot's agent story;
  no MCP path may bypass tenant checks.

### 2.13 Realtime — ADAPT (do not adopt SSE as-is)
- Sources: `backend/src/events.js` + `backend/src/routes/events.js` (SSE; note:
  SESSION-HANDOFF records SSE was removed for Chats polling — verify current
  wiring before reuse).
- Green Pilot (§11) requires Socket.io with rooms `org-${organizationId}` and
  events `inbound-message`, `message-status-update`, `conversation-updated`,
  `lead-qualified`; explicit CORS origins (current `index.js` allows any
  localhost port + `CORS_ORIGIN` — production wildcard behavior must be removed
  and origins made explicit). Never broadcast cross-tenant.

### 2.14 Status reconciliation + account health — ADOPT
- Sources: `backend/src/services/statusReconciler.js` (boot 7-day sweep + 60 s
  2-day pass, monotonic), `backend/src/services/accountHealth.js`
  (`markAccountHealth`, `classifyMetaError`), webhook audit trail (§2.3).

### 2.15 Handoff / close-summary — ADAPT
- Sources: `backend/src/services/agentHandoff.js`, `agentCloseSummary.js` (2-min
  idle-summary sweeper).
- The persistent per-conversation AI on/off flag (§13) does not exist and must be
  added (DB field + API + UI toggle); `AI disabled` path persists + notifies the
  team with **no** autonomous reply.

### 2.16 Excluded
- Advertising: no source exists; nothing adopted. Any future Revenue Pilot work
  stays out of this tree.
- ForgeChat UI/branding/landing/pricing: do not migrate (README, logos,
  trademarks remain ForgeChat property per `TRADEMARK.md`).

## 3. Cross-cutting deltas the adapters must carry
1. **Tenant column + composite ownership** (`organizationId` + entity id) on every
   WhatsApp/CRM/AI/automation write — the single largest migration item.
2. **API contract shift**: legacy `/api/*` routes → canonical `/api/v1/*`
   (`/api/v1/webhooks/whatsapp/:orgId`, `/api/v1/chats`, `/api/v1/leads/:id/messages`).
3. **Language/framework shift**: plain JS/Express 4/pg → TypeScript/Express
   5/Prisma; Vite/React 18 → Next.js/React 19/Zustand `useChatStore` backed by
   real APIs (no mocks).
4. **Security hardening**: mandatory per-org webhook secret enforcement (close
   the warn-only gap), explicit Socket.io CORS, tenant-scoped AI/tools/queues,
   no client exposure of WhatsApp tokens or provider keys.
