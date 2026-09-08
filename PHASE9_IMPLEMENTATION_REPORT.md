# PHASE 9 — Implementation Report (AI Lead Qualification)

## 1. Components reviewed + classification

Full table in `PHASE9_AI_FORENSIC_REPORT.md`. In short: provider adapters
KEEP (+test seam, +SDK typing fix); agent runtime/queue/router/tools/handoff/
agent routes/ai-models/transcription/close-summary/UI ADAPT (tenant scoping,
quota, guards); MCP service DEFER (deployment-level, untouched);
qualification engine REBUILD (new `src/ai/`); generic-agent expansion,
streaming, new providers, adtech REMOVE (out of scope).

## 2. Architecture

Canonical flow in `PHASE9_AI_ARCHITECTURE.md`: webhook persist → router →
queue (org re-check, ledger pre-check, quota gate) → `runAgent`
(org-revalidated, scoped queries, guarded prompt) → run ledger →
`runQualification` (eligibility, dedupe, tool-less extraction, zod,
persist, timeline, charge, emit) → `lead-qualified` → org room.

## 3. Tenant context

Explicit `{ organizationId, agentId, conversationId, contactNumber,
inboundMessageId }` end to end. Queue re-resolves agent+account orgs;
engine revalidates (agent org, account org) with no-retry `tenant-mismatch`;
all reads/writes use strict scope semantics (org rows only for org callers,
legacy rows only for legacy callers — mirrors `assertOrgRow`). No global,
browser-org, last-job, or env inference anywhere.

## 4. AI configuration ownership

Agents stamped on create, adopted on first management write, invisible→404.
`qualify_leads` + `qualification_rules` are org-owned config (editor UI
added). `ai_models` dual-read (global fallback preserved, stamped rows
owner-visible); creation stamps org. WA-account binding validated per org.

## 5. Qualification flow

Extraction-only LLM call (zero tools) → zod validation → `lead_qualifications`
(status/score/intent/summary/budget/timeline/requirements, NULLs stay NULL)
→ `lead_notes` timeline → charge → `lead-qualified` (ids only). Outcomes use
the four canonical states; nothing is auto-"qualified" (stub-independent
logic: status must validate; low-evidence transcripts yield
needs-more-information/unknown per prompt rules).

## 6. Quota enforcement + ledger

Phase 8 functions reused verbatim: pre-execution read-only `checkQuota`,
post-success `recordAiUsage` (1 credit/run, 1/qualification, distinct keys),
plus new read-only `hasAiUsage` pre-check. No second system, no hardcoded
plan limits in AI code. Over-quota/unentitled runs never reach the model.

## 7. Failure/refund semantics

Provider throw/timeout/malformed/ineligible → no persist, no charge; retries
re-enter idempotently (single charge proven). Lost quota races compensate via
delete (no orphan, no charge). Close-summaries gated + daily-key ledgered.

## 8. Idempotency

Ledger pre-check (run), `UNIQUE(org,message)` (qualification persist),
`message+'#qualify'` ledger key, per-contact serial jobIds. One durable
message → one execution → one charge (test-proven, incl. retry).

## 9. Provider failure handling

Timeout wrapper (90s), error mapping (`provider-failed`/`provider-timeout`),
BullMQ attempts for transient throws, no-charge invariant, no endless loops
(adapter maxIterations unchanged).

## 10. CRM tools

Executors pre-bound to strict `(org, wa, contact)`; writes fail closed on
scope miss; assignees must be org members; taxonomy reads stay global
(documented exception). Forged-scope and foreign-assignee tests pass.

## 11. WhatsApp sending

Unchanged path (`enqueueSend` → `sendQueue` → `tenantJobAllowed`), plus
engine-side account-org verification and org-scoped media/template lookups.
Cross-org send attempts fail before any model/provider spend.

## 12. Output validation

zod schema (enum/scores/summary-required), oversize accepted-then-truncated,
unknown keys stripped, code-fence tolerance, fence-only JSON parsing. Invalid
→ reject with no side effects.

## 13. Prompt-injection handling

Non-editable `AI_SECURITY_PREAMBLE` on every system prompt; qualification is
tool-less; executors take no ids; context minimized (last-N messages +
name/tags). Injection test: hostile transcript changes nothing cross-scope
and leaks nothing.

## 14. Credentials

Unchanged posture (server-side registry/env, masked UI, no reveal call-site,
nothing in prompts/logs/sockets/errors). Verified by grep + response-body
assertions.

## 15. Context minimization

Qualification sees transcript slice (≤12k chars) + org rules only; agent runs
keep their configured window, now org-scoped. No full-row dumps, no keys.

## 16. CRM + timeline

`lead_qualifications` (structured) + `lead_notes` (auditable, CoT-free,
`created_by NULL` = AI). No pipeline/deal automation (Phase 10 territory).

## 17. Realtime

Real `emitLeadQualified` calls post-write → `org:{id}`; socket payload is
ids-only (frontend fetches detail). A-only delivery test-proven (Phase 7
contract untouched).

## 18. Frontend

Qualification banner (API detail + socket refresh hint), editor qualify
section, existing usage/bot-toggle surfaces unchanged, no secrets/prompts/CoT
exposed. One compatibility fix (existing header-test mock).

## 19. Tests — backend 125/125, frontend 77/77 (detail: `PHASE9_AI_TEST_REPORT.md`)

## 20. Builds

`tsc` ✅ · `eslint` ✅ · `vite build` ✅ · migrations 68/68 ✅.

## 21. Remaining limitations

- `runAgent`-success e2e (reply send) needs Redis; covered at unit/service
  level + pre-existing worker patterns, not live-fired here.
- `agentService` (MCP-only) still unscored — deferred, documented.
- Close-summary sweeper batch is global (per-conversation isolation kept).
- Agent export still bundles tool secrets (admin-only, pre-existing, kept).
- `ai_models` global rows editable by any org admin (shared stewardship).

## 22. Unresolved business decisions

Qualification score thresholds per plan; per-plan AI pricing beyond credit
accounting; seat/message quotas; `past_due` grace; cancelled period-end
access (all carried over from Phase 8, unchanged). No pricing invented.

---

**PHASE 9 STATUS: COMPLETE**
