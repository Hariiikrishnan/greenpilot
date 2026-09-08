# PHASE 11 — CRM Test Report

## Backend — `backend/test/crm.test.js` (17 tests)

Pure unit (status vocabulary) always runs; DB-backed parts self-provision
(migrations incl. 069) and skip without a database. BullMQ transport captured
(same pattern as Phase 10); no Redis required. Own phone-number range +
exact-scope cleanup (parallel files share one DB; global `(wa,contact)` keys
would otherwise race — enforced after flakes proved it).

| # | Case | Result |
|---|---|---|
| 1 | Status vocabulary (approved set, no ad terms) | PASS |
| 2 | Lead CRUD + duplicate 409 with leadId + by-contact + delete | PASS |
| 3 | Cross-org lead access → 404s; forged org → 403; B list clean | PASS |
| 4 | Status: enum rejected; change audited; repeat no-op; socket to A only, B nothing | PASS |
| 5 | Foreign stage 404; set + clear round-trip | PASS |
| 6 | Member assign/unassign; foreign/ghost users 400 | PASS |
| 7 | Pipelines org-scoped CRUD; PUT shape includes stages | PASS |
| 8 | Deal integrity: foreign pipeline/stage/assignee rejected; contact mirror | PASS |
| 9 | Deal move: derived won + won_at; same-stage no-op; member own/other rules; exactly one deterministic bus event | PASS |
| 10 | Notes/calls CRUD; cross-tenant 404s; B sees empty | PASS |
| 11 | Follow-ups: past-due/foreign-assignee rejected; complete/cancel; double-complete 404; B isolation | PASS |
| 12 | Timeline merges notes/qualification/messages; scoped; bounded; CoT-free; B 404 | PASS |
| 13 | Pagination bounded/clamped; non-overlapping pages; search/assignee filters tenant-clean | PASS |
| 14 | Concurrent stage moves → single consistent stage | PASS |
| 15 | Status automation terminates (visited/depth, max depth 1) | PASS |
| 16 | E2E sales flow (inbound → lead → AI state → assign → stage → note → follow-up → timeline → socket A-only) | PASS |
| 17 | contacts/save: cross-org 403 (even global admin), foreign assignee 400, own save works | PASS |

**17/17 pass.**

## Frontend (5 new tests)

- `LeadDetail.test.jsx`: real-data render (status/qualification/follow-ups/
  timeline); status change via canonical endpoint; note add + refresh; call
  log + follow-up schedule; honest load-error state.

## Regression totals

- Backend full suite: **165/165** (148 Phase 6–10 + 17 Phase 11), 0 fail
  (3 consecutive green full runs).
- Frontend unit: **86/86** across 9 files (81 + 5), 0 fail.
- `tsc --noEmit` (CRM surface included): exit 0, no suppressions.
- `eslint`: exit 0. `vite build`: success. Migrations 70/70 (`069`,
  additive only).
- Known flake (documented, mitigated): parallel-suite file deaths under load
  (number-range separation, exact cleanup, tracked sockets, lighter fixtures);
  no recurrence in final verification window.
