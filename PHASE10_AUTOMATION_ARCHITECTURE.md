# PHASE 10 — Automation Architecture (canonical)

## Model

```text
Automation (chatbots row: org-owned, status active/inactive/draft,
           trigger node + config graph)
  → Event { organizationId, eventType, entityId, eventId, payload,
            depth, visitedAutomationIds }
  → Execution (org-stamped, UNIQUE(org, automation, event) idempotent,
               depth, test_mode, queued→running→success/error/paused/cancelled)
  → Worker walk (conditions → actions, revalidated tenant context)
  → Result (CRM / follow-up / WhatsApp / AI) + history + realtime
```

`Automation` rows are the existing `chatbots` table (org column exists via
062/065); `Execution` rows are `automation_executions` (+068 columns
`event_id`, `depth`, `test_mode`). Steps stay child-scoped (no org column —
parent-owned, established pattern).

## Triggers (approved set)

| Trigger | Event source | eventId (deterministic) |
|---|---|---|
| `keyword` | inbound WhatsApp, matcher on body | inbound `message_id` |
| `message_received` | any valid inbound (non-status) | inbound `message_id` |
| `lead_created` | first-ever inbound from a contact | `lead:{org}:{wa}:{contact}` |
| `lead_qualified` | Phase 9 qualification success | `qualified:{qualificationId}` |
| `lead_status_changed` | qualification status transition / update-lead-status action | `status:{qualificationId}` |
| `followup_due` | due sweeper claims a pending follow-up | `followup:{id}:{due_at}` |

Legacy kinds (`anyMessage/newContact/messageRead/.../link/qr/tagApplied/
webhook/apiEvent`) stay non-firing; `webhook`/`apiEvent` kinds are rejected
at save validation (no arbitrary inbound HTTP without a security review).
Payloads carry ids + minimal context only.

## Conditions (minimum useful set)

Existing operators kept (`equals/contains/…/has tag/is true…`) on
`system/custom/tags/time` sources, PLUS a `qualification` source exposing
`qualification.status` and `qualification.score` (latest org-scoped result
for the conversation). All evaluation reads org-scoped data via the
execution context.

## Actions (approved set)

Kept (now org-scoped + membership-checked assignees): Assign to BDA, Add/
Remove Tag, Set/Clear Custom Field, Send WhatsApp message (template/direct
except `dynamic_api`, which is REJECTED — SSRF boundary).
New: Add Note (`lead_notes`), Schedule Follow-up (`follow_ups`, org-owned),
Update Lead Status (latest qualification status + emits `lead.status.changed`
with depth+1), Invoke AI Qualification (Phase 9 `runQualification`, same
message identity → duplicate-safe, quota-enforced, no second mechanism).
Parked stubs (email/sequences/scores/subscribe) stay stubs. `testMode`
simulates sends/AI/follow-ups (no customer messages, no quota, no writes).

## Service boundary

The engine orchestrates; it never re-implements business logic:
contacts/tags/fields via org-scoped queries + membership checks, notes/
follow-ups via direct org-stamped inserts, sends via `enqueueSend` →
`sendQueue` (org stamped from the validated account, `tenantJobAllowed`
re-checked), AI via Phase 9 service, qualification reads via the AI module.
No raw cross-table writes outside these paths.

## Queue architecture (`greenpilot-automation` BullMQ)

Job: `{ organizationId, automationId, executionId, eventId, resumeNodeId? }`.
Webhook/service paths only CREATE executions + enqueue (fast, under the 20s
ceiling); the worker walks. Worker revalidates: automation exists + active +
org-visible; execution org + status; referenced contact/conversation/
qualification/follow-up org. Attempts 3, exponential backoff. Delay nodes
requeue the SAME execution with `delayMs` + `resumeNodeId` (tenant context
travels in ids, revalidated on wake). `waitForReply` pause/resume unchanged
in semantics, org-scoped in queries.

## Idempotency

DB-first: `UNIQUE(organization_id, automation_id, event_id)` — same pair
returns the existing execution, no duplicate walk. WhatsApp sends:
pre-send step lookup (same execution+node already produced a live
`localMessageId` → reuse, no resend). AI: Phase 9 message-identity dedupe.
No in-memory locks anywhere.

## Retries

Transient throws retry (3 attempts); tenant refusals, validation errors, and
quota rejections complete immediately. `waitForReply` pauses are not retries.
Sweeper reaps orphaned `running` (>15m) and expires `paused` (pre-existing).

## Delays / scheduling

Duration delays via delayed requeue (durable, restart-safe); the legacy
`__pendingSendDelayMs` → `sendQueue delayMs` path is kept for message nodes
in sync walks. Date/field/until modes stay log-only (need a real scheduler —
documented limitation). `followup.due` sweeper (60s) claims
pending→done atomically per row, then emits.

## Execution history

Existing statuses kept (`queued/running/success/error/paused/cancelled` —
established domain, no CHECK churn) + `test_mode` flag surfaced in history
responses. Errors store messages only (no stack traces to users).

## Loop protection

Depth counter (max 5) + visited-automation set on every emitted event;
emitting actions (`update_lead_status`) increment depth and append self;
service skips visited/deep automations with a logged reason. Single-walk
cycle guard retained. Outbound sends never emit automation events (no
send-loop by construction).

## Event cascade (deterministic)

Inbound → (message automations) + agent/AI → `lead.qualified` → status/tag/
assign/follow-up automations → `lead.status.changed` → downstream automations
(depth-bounded). Each hop is a separate idempotent execution.

## Realtime

`automation-started/completed/failed` → `org:{id}` (execution + automation
ids + status only), emitted by the worker. Added to the emitter allowlist.

## Frontend

Builder keeps working on real (now org-scoped) APIs; palette = approved
triggers/actions; unsupported node groups stay hidden; `dynamic_api` removed
from message types; test-preview simulator calls the real
`POST /v1/automations/:id/test-run` (simulated side effects). No rebuild.

## Unresolved / deferred

Date/field/until delays (need scheduler); `webhook`/`apiEvent` triggers
(security review required); email/sequence actions (unbuilt); MCP
`agentService` (deployment-level, untouched); multi-instance automation
worker (Redis-backed BullMQ already — safe).
