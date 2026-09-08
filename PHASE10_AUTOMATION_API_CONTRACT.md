# PHASE 10 — Automation API Contract

Two namespaces, one implementation (`src/automation/service.js`):
legacy `/api/chatbots*` + `/api/executions/*` (shapes unchanged) and
canonical `/api/v1/automations/*` (automation terminology). Auth: session
cookie. Org: `req.org` (membership-derived; forgery → 403 upstream).
Mutations additionally require the `chatbot-builder` page grant (existing
permission model). Invisible automations/executions read as 404 (no probing).

## Automations

- `GET /automations` → array of visible automations
  `{ id, name, description, status, trigger_type, config, created_at,
  updated_at }` (org + legacy dual-read).
- `GET /automations/:id` → single or 404.
- `POST /automations` `{ name*, description?, status?, trigger_type?,
  config* }` → 201 (org stamped). Config validated: exactly one trigger of
  an approved kind; approved node types only; no `dynamic_api`; approved
  action kinds only. Violations → 400 with the reason (never silent drops).
- `PUT /automations/:id` → updated row or 404 (legacy rows adopted into the
  acting org on first write).
- `POST /automations/:id/enable` → `{ status:'active', … }`;
  `POST /automations/:id/disable` → `{ status:'inactive', … }`.
- `POST /automations/:id/duplicate` → 201 disabled copy in the acting org.
- `DELETE /automations/:id` → `{ ok:true }` or 404.
- `GET /automations/:id/executions?page&limit&status` → `{ executions,
  total, page, totalPages }` (org-scoped; `test_mode` surfaced per row).

## Test run (Step 23)

- `POST /automations/:id/test-run`
  `{ contactNumber?, waNumber?, messageText? }` → synchronous walk with ALL
  side effects simulated: `{ execution: { …, test_mode:true }, steps: […],
  simulated:true }`. No WhatsApp sends, no AI/quota consumption, no CRM
  writes. Requires saved automation (unsaved/dirty → client-side guard) and
  the builder grant. Side effects are simulated server-side (not just hidden
  client-side), so there is no free-execution path.

## Legacy executions (unchanged shapes, now scoped)

- `GET /chatbots/:id/executions` (+ status/date/messageStatus filters),
  `GET /executions/:id` (+ steps), `POST /executions/:id/cancel`
  (409 when already finished, 404 when invisible). History rows now include
  `event_id`, `depth`, `test_mode`.

## AI adjuncts (Phase 9, referenced)

- `POST /v1/ai/conversation-mode` (AI mode toggle used by eligibility).
- `GET /v1/ai/qualifications` (condition data source reads server-side).

## Worker-internal contracts (not HTTP)

- `enqueueAutomationRun({ organizationId, automationId, executionId,
  eventId, resumeNodeId? }, { delayMs? })` → BullMQ `greenpilot-automation`
  (`jobId: auto-{executionId}[-resume-{node}]`, attempts 3, exponential
  backoff, delayed requeue for delay nodes).
- `processJob` revalidates automation (exists + active + org), execution
  (org + queued/running), and referenced entities per event type; emits
  `automation-started/completed/failed` to `org:{id}`.

## Event types (bus)

`whatsapp.message.received`, `lead.created`, `lead.qualified`,
`lead.status.changed`, `followup.due` — each `{ organizationId, eventType,
entityId, eventId, payload, depth, visited }`. Deterministic ids:
`msg:{message_id}`, `lead:{org}:{wa}:{contact}`, `qualified:{id}`,
`status:{id}`, `followup:{id}:{due_at}`. Depth cap 5, visited-skip.
