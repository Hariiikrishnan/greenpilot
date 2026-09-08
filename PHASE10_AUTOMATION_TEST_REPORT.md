# PHASE 10 — Automation Test Report

## Backend — `backend/test/automation.test.js` (23 tests)

Pure unit parts always run; DB-backed parts self-provision (migrations incl.
068) and skip without a database. Stubbed boundaries (and ONLY these):
BullMQ transport (`enqueueAutomationRun` captured — worker logic runs for
real via `processJob`) and the external LLM (`test-echo` seam, Phase 9
pattern). Message-send walks use `testMode`/throw-before-enqueue paths;
live sends are covered by the Phase 7/8 suites. Each file owns a distinct
phone-number range (parallel `--test` processes share one DB; global
`(wa,contact)` keys would otherwise race — enforced after flakes proved it).

| # | Case | Result |
|---|---|---|
| 1–2 | Config validation keeps approved graphs; rejects webhook/apiEvent triggers, api/subflow nodes, dynamic_api, bad actions, triggerless, dup ids | PASS |
| 3 | Trigger matching (keyword/account-filter/message/lead/all four event kinds; negatives) | PASS |
| 4 | Canonical CRUD stamps org; B list/get/put/delete on A → 404 | PASS |
| 5 | Member without builder grant: writes 403, reads 200 | PASS |
| 6 | Unsafe configs → 400 over HTTP (no silent drops) | PASS |
| 7 | Enable/disable flip; duplicate copies disabled into acting org | PASS |
| 8 | OrgB event fires only orgB automations; orgA counts unchanged | PASS |
| 9 | Same event twice → same execution, `duplicate:true`, no re-enqueue | PASS |
| 10 | Visited-skip + depth-6 drop | PASS |
| 11 | Forged-org job refused without walking; execution untouched | PASS |
| 12 | Deactivated automation → cancelled-inactive; redelivery → already-success | PASS |
| 13 | Missing tenant context throws | PASS |
| 14 | E2E: inbound → executions → walks → tag+note → success history → socket started/completed to A only, B nothing | PASS |
| 15 | First inbound emits lead.created; second does not | PASS |
| 16 | Failing node → execution error with message-only reason | PASS |
| 17 | Delay suspends (delayMs + resumeNodeId captured, org preserved) → resume walk succeeds + tag applied | PASS |
| 18 | Update-lead-status changes verdict + creates depth-1 status.changed execution | PASS |
| 19 | AI action runs real Phase 9 qualification (1 LLM call, row persisted, `#qualify` ledger charged) | PASS |
| 20 | Sweeper claims due row only; followup.due execution walks to tag | PASS |
| 21 | Test-run returns simulated steps; zero tag writes; zero quota delta; B → 404 | PASS |
| 22 | Execution get/list scoped; cancel → cancelled → 409; B cancel → 404 | PASS |
| 23 | Forged-org message flow fails closed naming the tenant boundary; testMode simulates with zero outbound rows | PASS |

**23/23 pass.**

## Frontend (4 new tests)

- `AutomationBuilderSurface.test.jsx`: approved trigger display map,
  canonical lead statuses, node defaults, `api.automations` surface incl.
  `testRun`.
- Existing suites untouched and green (builder was adapted, not rebuilt).

## Regression totals

- Backend full suite: **148/148** (125 Phase 6–9 + 23 Phase 10), 0 fail
  (3 consecutive green runs post-fix).
- Frontend unit: **81/81** across 8 files (77 + 4), 0 fail.
- `tsc --noEmit`: exit 0 — new surface included; transitively-reached
  legacy patterns (ioredis CJS, untyped error props, SDK constructors) fixed
  with zero runtime change (typed error classes, CJS normalization, JSDoc).
- `eslint src/ test/ scripts/`: exit 0. `vite build`: success.
- Migrations 69/69 applied (`068_automation_events`, additive only).
- Flakes fixed, not hidden: JSONB-already-parsed trigger_data (real bug),
  parallel-suite number/cleanup collisions (ranges + exact cleanup),
  leaked-socket hang on assertion failure (tracked sockets in `after()`).
