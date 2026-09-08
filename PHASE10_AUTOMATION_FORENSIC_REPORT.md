# PHASE 10 — Automation Forensic Report (ForgeChat → Green Pilot)

Method: full read of `engine/automationEngine.js` (1416 lines), `routes/
chatbots.js` (346), queue modules, webhook call sites, builder UI sampling,
and migration/DDL grep. Evidence with file:line below.

## Headline

A working single-tenant keyword automation engine with **zero** organization
scoping (`organization|req.org|tenant` hits in engine + routes: **0**), no
idempotency, no dedicated queue (synchronous in-webhook walks; only delayed
sends delegate to BullMQ), and an API layer (`sanitizeToLinear`) that
**deletes** condition/delay/action nodes on every save. Triggers other than
`keyword` are dead code; `handoff/ai/api/subflow` handlers are parked stubs.

## Inventory + classification

| # | Subsystem | Evidence | Verdict |
|---|---|---|---|
| 1 | Keyword trigger + matcher | engine:1387-1393, matcher 15-27, account filter 1379-1382 | **ADAPT** (org-scope + event bus) |
| 2 | Dead trigger kinds (anyMessage/newContact/read/…​) | engine:1384-1386 gate | **REMOVE** (from firing set; kinds rejected at validation except approved new ones) |
| 3 | Message node (template/direct, quick_reply/list/location/media) | engine:259-765 via sendQueue | **ADAPT** (org-scope lookups, retry-safe resend guard, testMode) |
| 4 | `dynamic_api` direct mode (raw fetch, 15s timeout) | engine:341-431 | **REMOVE** (SSRF boundary; reject at validation + execution) |
| 5 | Condition node + 15 operators + 5 sources | engine:143-176, 767-771 | **KEEP** (+ `qualification` source) |
| 6 | Delay node (duration-only real) | engine:773-799, sendQueue delayMs | **ADAPT** (worker delayed-requeue; date/field/until stay log-only) |
| 7 | Action node: assign/tag/field CRUD | engine:826-998 | **ADAPT** (org-scope writes, membership-checked assignees) |
| 8 | Action stubs (email/sequences/scores/subscribe) | engine:804-813, 1000-1003 | **KEEP** as stubs (honest no-ops) |
| 9 | `api`/`http_request` builder node + validateHttpConfig | routes/agents domain; builder NT map | **REMOVE** from automation surface (unsupported; 400 at save) |
| 10 | `ai` builder node (`aiTask: lead_qualification`) | builder palette-hidden; engine stub 1025 | **REBUILD** as real action via Phase 9 service |
| 11 | `handoff`/`subflow` nodes | engine stubs 1013/1045, hidden palette | **REMOVE** from automation (handoff covered by agent service; subflow unbuilt) |
| 12 | `waitForReply` pause/resume + expiry + sweeper | engine:746-764, 1183-1307; index:224-244 | **ADAPT** (org-scope queries) |
| 13 | Executions + steps tables | 010/011/030 migrations; statuses running/success/error/paused/cancelled/queued | **KEEP** (+068 `event_id/depth/test_mode`) |
| 14 | `sanitizeToLinear` (destroys branching on save) | chatbots.js:17-55, applied 99/125/191 | **REMOVE** → replaced by validating keeper |
| 15 | chatbots CRUD/routes/shapes | chatbots.js:58-346 | **ADAPT** (org-scope; shapes kept for UI compat) |
| 16 | Sync in-webhook execution | webhook.js:575-603 | **ADAPT** (create+enqueue; worker walks) |
| 17 | Builder UI (4138 lines, Automations-branded, ForgeChat-free) | ChatbotBuilderPage, AutomationBuilderView | **ADAPT** (approved palette, no rebuild) |
| 18 | Executions viewer + flow canvas | AutomationExecutions, ExecutionFlowCanvas | **KEEP** (works on scoped APIs) |
| 19 | Test-preview simulator (client-side only) | builder:3271+ | **ADAPT** (wire to real test-run endpoint) |
| 20 | follow_ups table (strict org, due_at, zero backend usage) | 063:71-82; 0 src hits | **ADAPT** (action writes + due sweeper) |
| 21 | Broadcasts | own logs/originRef, 0 automation refs | **DEFER** (untouched) |
| 22 | Generic marketplace/webhook triggers, cron scheduler, adtech | — | **REMOVE**/out of scope |

## Gaps Phase 10 closes

1. Tenant isolation: nothing filters by org (engine, routes, resume, sweeper
   lookups, template/media/tag/field/user reads, contact upserts).
2. `resolveAccount` single-account fallback can cross accounts
   (`messageSender.js:33-34`); engine never stamps `organizationId` on sends
   (sendQueue auto-resolves — works only when the account is org-bound).
3. Duplicate inbound → duplicate executions; retries mint new `localMessageId`
   rows (double-send risk); no automation queue identity at all.
4. Recursive status changes unbounded (single-walk cycle guard only).
5. `follow_ups`, `lead_qualified` event, AI action, execution realtime:
   nonexistent.
6. Builder offers node types the API silently deletes (data-loss on save).

## Secret/env posture

No automation secrets exist (message sends use per-account tokens via the
existing token service; no new credentials). `dynamic_api` removal reduces
the SSRF surface. Historical scrub remains separate.
