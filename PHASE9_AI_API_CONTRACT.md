# PHASE 9 — AI API Contract

Base: `/api/v1/ai/*` (legacy `/api/*` compat via the shared mount). Auth:
session cookie. Org: `req.org` (membership-derived; forgery → 403 upstream).
Reads: any member. Errors: `{ error, code? }`, never secrets/prompts/CoT.

## GET /ai/status (member)

`200`: `{ organizationId, entitled, subscriptionState, usage: { granted,
used, remaining }, providers: ['anthropic','openai'],
qualifyingAgents: <count of active qualify_leads agents in org>,
canManageBilling, pricingFinalized: false }`.

## GET /ai/qualifications (member)

Query: `limit` (1–100, default 20); optional `waNumber` + `contactNumber`
(digits-normalized server-side) narrowing to one conversation, latest first.
`200`: array of `{ id, conversationId, waNumber, contactNumber, agentId,
status, score, intent, summary, evaluatedAt }`. Only validated persisted
fields — never raw output or reasoning.

## GET /ai/qualifications/:id (member)

Org-scoped single result; foreign ids → `404` (no cross-tenant probe).

## GET /ai/usage (member)

`200`: `{ organizationId, usage: {...}, recent: [{ inboundMessageId,
agentId, contactNumber, model, tokensIn, tokensOut, costCredits,
createdAt }] }` (latest 50 ledger rows, org-scoped).

## POST /ai/conversation-mode (member + contact access)

Body `{ waNumber, contactNumber, enabled }` (all required, else `400`).
`assertContactAccess` enforced first. Upserts the org thread row
(`ai_enabled`); creates a stub when no thread exists yet.
`200`: `{ ok:true, waNumber, contactNumber, aiEnabled }`.

## Existing evolved endpoints (no duplicates created)

- Agent CRUD `/agents*` (+`qualify_leads`, `qualification_rules`), org-scoped
  via `assertAgentAccess`, creation stamps org, legacy adoption on write.
- `/agent-conversation`, `/pause`, `/resume`: org-bound contact reads/writes;
  assignees must be org members.
- `/ai-models*`: dual-read (global + own org); org-stamped rows mutate
  through their org only.
- Billing usage surfaces stay in `/billing/*` (no second quota API).

## Worker-internal contracts (not HTTP)

- `enqueueAgentRun({ agentId, contactNumber, inboundMessageId, inboundText,
  organizationId })` → `processJob` (exported for tests): tenant re-check →
  ledger pre-check → quota gate → `runAgent` → run ledger → optional
  `runQualification`. Refusals/duplicates/quota-skips COMPLETE the job.
- `runQualification({ organizationId, agentId, conversationId, waNumber,
  contactNumber, inboundMessageId, agentRunId })` → `{ ok, duplicate?,
  qualification? | reason }`.
