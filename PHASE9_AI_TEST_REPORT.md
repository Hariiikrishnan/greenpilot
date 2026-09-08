# PHASE 9 — AI Test Report

## Backend — `backend/test/aiQualification.test.js` (29 tests)

Pure unit parts always run; DB-backed parts self-provision (migrations incl.
067) and skip without a database. The external LLM boundary alone is stubbed
(`llm/__setProviderForTests`); webhook-shape persistence, routing context,
worker logic, qualification, ledger, CRM, and realtime are REAL services.
No Redis needed: tests invoke `processJob`/`runQualification` directly (the
exact functions the BullMQ worker calls).

| # | Case | Result |
|---|---|---|
| 1–2 | `parseQualificationResult` valid forms accepted | PASS |
| 3 | Malformed / bad-enum / impossible-score / missing-summary rejected | PASS |
| 4 | Oversized truncated to caps, unknown keys stripped | PASS |
| 5 | `isSafeHttpUrl` matrix (11 blocked, 3 allowed) | PASS |
| 6 | Security preamble appended once, instruction-bearing | PASS |
| 7 | Transcript shaping + prompt embeds org rules, no secrets | PASS |
| 8 | Eligibility happy path | PASS |
| 9 | Gates: not-enabled / paused-for-human / ai-disabled / no-model / foreign-agent | PASS |
| 10 | Success: validated row + timeline note + `#qualify` ledger + **A receives, B receives nothing**, payload internals-free | PASS |
| 11 | Duplicate message: one LLM call, one charge, `duplicate:true` | PASS |
| 12 | Provider failure: nothing persisted, usage unchanged | PASS |
| 13 | Retry-after-failure: single ledger row + single qualification row | PASS |
| 14 | Malformed output: rejected, no persist, no charge | PASS |
| 15 | Foreign agent → 404 | PASS |
| 16 | CRM forged scope throws; own-org write works; victim row untouched | PASS |
| 17 | Foreign BDA assignee skipped (null) yet in-org pause applies; resume clears | PASS |
| 18 | Cross-org handoff throws | PASS |
| 19 | `runAgent` cross-org → `tenant-mismatch`, zero model calls | PASS |
| 20 | `processJob` cross-org → `refused-tenant-mismatch`, zero model calls | PASS |
| 21 | Over-quota → `quota-exhausted`, zero model calls | PASS |
| 22 | Cancelled subscription → `subscription-cancelled`, zero model calls | PASS |
| 23 | Injection message: zero-tool run, no cross-org write, no secret/prompt leak | PASS |
| 24 | `GET /ai/status`: entitlement + usage, no key material | PASS |
| 25 | Qualifications list org-scoped; B sees none of A; forged org 403 | PASS |
| 26 | Conversation-mode toggle drives eligibility both ways | PASS |
| 27 | Agents API: B list/get/put/delete on A agent → 403-free 404s; A reads qualify flag | PASS |
| 28 | Creation stamps org; foreign WA account → 400 | PASS |
| 29 | Update persists qualify fields; metadata-IP tool URL → 400 | PASS |

**29/29 pass** (3 consecutive full-suite runs: 125/125; one transient
socket-timing flake observed once in a parallel run, not reproduced).

## Frontend (5 new tests)

- `ChatWindowQualification.test.jsx` (3): banner loads from API; matching
  `lead-qualified` refetches, foreign ignored; empty state renders nothing.
- `AgentEditorQualification.test.jsx` (2): saved qualify state shows rules;
  toggle + rules persist through save payload.
- Existing `ChatWindow.header.test.jsx` mock extended (`ai`,
  `agentConversation`); 6/6 still pass.

## Regression totals

- Backend: **125/125** (96 Phase 6+7+8 + 29 Phase 9), 0 fail.
- Frontend: **77/77** across 7 files (72 + 5), 0 fail.
- `tsc --noEmit` (AI surface + transitively-reached llm adapters now checked;
  two pre-existing SDK-typing issues fixed without behavior change): exit 0.
- `eslint`: exit 0. `vite build`: success. Migration 067 applied (68/68).
