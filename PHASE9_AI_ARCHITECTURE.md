# PHASE 9 — Green Pilot AI Architecture (canonical)

## Lifecycle

```text
Inbound WhatsApp message
  → webhook: persist (org-stamped) + conversation thread
  → agentRouter: active agent? trigger? → enqueueAgentRun (+organizationId)
  → agentQueue worker: re-validate org (account + agent) → ledger pre-check
      (same message already processed? → duplicate, no charge)
    → runAgent (org-revalidated, org-scoped queries, guarded prompt)
      → on success: recordAiUsage(key=inboundMessageId, cost 1)
      → on provider/LLM failure: NO ledger write (no charge), job retries
    → qualification (only if agent.qualify_leads):
        eligibility (AI mode + not paused + entitled + quota available)
        → duplicate check (org+message already qualified? → return existing)
        → structured-output LLM call (NO tools — extraction only)
        → zod validation (reject malformedсии → no persist, no charge)
        → persist lead_qualifications + lead_notes timeline entry
        → recordAiUsage(key=inboundMessageId#qualify, cost 1)
        → emit lead-qualified → org:{organizationId}
```

Every step carries explicit `{ organizationId, agentId, conversationId,
contactNumber, inboundMessageId }`. Nothing is inferred from globals,
last-processed state, or the browser org.

## Tenant context rules

- Queue jobs carry `organizationId`; workers re-resolve agent + account orgs
  from the DB and refuse mismatches (no retry).
- `runAgent` revalidates inside the engine (defense in depth): agent org ∈
  {null legacy, job org} AND account org ∈ {null legacy, job org}.
- All engine reads/writes (history, media, templates, contacts, handoff)
  filter by `organization_id` when known; legacy NULL rows remain readable
  (dual-read) but are never written cross-org.
- Agents are managed through `assertAgentAccess` (org match or legacy NULL
  with adoption-on-write; invisible → 404, never 403-probeable).
- `ai_models` stays global (documented exception); org-stamped rows are
  owner-org visible.

## Qualification model (`lead_qualifications`)

`{ organization_id, conversation_id, wa_number, contact_number, agent_id,
agent_run_id, inbound_message_id UNIQUE-per-org, status ∈
{qualified, unqualified, needs-more-information, unknown}, score 0–100,
intent, summary, evaluated_at }`. Only these fields persist — never raw
model output, never chain-of-thought. Missing/unknown values stay NULL /
`unknown`; nothing is fabricated.

## AI mode (persistent, backend-enforced)

`conversations.ai_enabled` (default TRUE) AND `contacts.agent_paused = FALSE`
(operator take-over). Missing conversation row = enabled. Toggle: `POST
/ai/conversation-mode` (contact-access checked). Eligibility is evaluated
server-side per run — frontend state is display only.

## Quota contract (Phase 8 verbatim, no second system)

- Pre-execution: read-only `checkQuota` (entitlement + availability).
- Post-success: `recordAiUsage` (1 credit per agent run, 1 per
  qualification; distinct idempotency keys).
- Provider failure / timeout / malformed output / ineligibility → NO debit.
  Retry-after-failure charges at most once (ledger dedupe + pre-check).
- Duplicate message/job → pre-check returns existing, no LLM call, no charge.
- Over-quota / unentitled → run skipped with logged reason; UI shows safe
  paused state (never silent execution, never free fallback).

## Idempotency keys

- Agent execution + run charge: `(organization_id, inbound_message_id)` via
  `ai_usage_ledger` UNIQUE (+ read-only pre-check).
- Qualification + qualification charge: `(organization_id,
  inbound_message_id)` via `lead_qualifications` UNIQUE; ledger key
  `inbound_message_id + '#qualify'`.
- Queue jobId `agent-{agent}-{contact}-{message}` keeps per-contact serial
  order (pre-existing).

## Tool safety

- CRM executors are pre-bound to `(org, wa, contact)` — the model supplies
  only field values, never ids. Cross-org writes are structurally impossible.
- Sheets/HTTP tools keep deployment-level credentials (documented); HTTP
  URLs validated at save AND at execution (`isSafeHttpUrl`: http/https only,
  no loopback/link-local/metadata/userinfo).
- WhatsApp sends always flow through `enqueueSend` → `sendQueue` (org stamped
  from the account, `tenantJobAllowed` re-validated). The engine never picks
  an account outside its validated one.

## Output validation & injection defense

- Qualification output validated by zod; oversized/unknown/enum-violating
  payloads rejected before persistence.
- `AI_SECURITY_PREAMBLE` (server-side, non-editable) appended to every
  system prompt: customer messages are untrusted data; no system/credential
  disclosure; tool-only actions; server controls cannot be overridden.
- Context minimization: last-N messages (agent's configured window), contact
  name/tags only — never full DB rows, keys, or other tenants' data.

## Realtime & CRM timeline

- `lead-qualified` (Phase 7 contract, ids-only payload) → `org:{id}` after
  CRM writes. Frontend fetches detail via API (socket stays minimal).
- Timeline: `lead_notes` row (org, contact_ref, summary, created_by NULL =
  AI) — auditable, CoT-free.

## Frontend surface

- Inbox: qualification banner on `lead-qualified` (fetch detail, org-checked).
- Agent editor: `qualify_leads` toggle + `qualification_rules` (org-owned config).
- Settings → Billing already shows AI credit usage (Phase 8); AI status API
  feeds entitlement display. No secrets/prompts/CoT exposed (unchanged).
