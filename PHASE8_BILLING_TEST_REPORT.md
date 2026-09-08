# PHASE 8 — Billing Test Report

## Backend — `backend/test/billing.test.js` (26 tests)

Pure unit parts always run; DB-backed parts self-provision via `runMigrations`
and skip without a database (CI-safe). Provider order API is stubbed at
`globalThis.fetch` (no network); HMAC paths use real crypto.

| # | Case | Result |
|---|---|---|
| 1–2 | Plan catalog resolves / public projection secret-free + placeholder-flagged | PASS |
| 3 | `subscriptionState` 10-row matrix (trial/active/past_due/cancelled/expired/suspended/unknown→closed/legacy row) | PASS |
| 4–5 | Payment + webhook HMAC accept-true/reject-forged | PASS |
| 6 | Status: trial entitled + usage grant; manager flags differ by role; no secret in body | PASS |
| 7 | Plans endpoint secret-free | PASS |
| 8 | Unauthenticated 401; forged `X-Org-Id` 403 | PASS |
| 9 | Org B cannot read/create-order on org A (403/403) | PASS |
| 10 | Plain member: create-order/verify/cancel all 403 | PASS |
| 11 | Valid plan → 201 order, public key only, zero secret bytes | PASS |
| 12 | Trial + unknown plans rejected (400) | PASS |
| 13 | No provider credentials → 503 `billing-unavailable` (no fake order) | PASS |
| 14 | Duplicate create-order reuses open order (`reused:true`, same id) | PASS |
| 15 | Valid signature → active/entitled; replay → `alreadyProcessed:true`, credits granted exactly once | PASS |
| 16 | Invalid signature → 403, subscription unchanged | PASS |
| 17 | Wrong-org order → 404 `order-not-found` (no leak) | PASS |
| 18 | Tampered DB amount → 400 `order-plan-mismatch` (forged price dies) | PASS |
| 19 | Webhook `order.paid` activates; replay 200; bad signature 403; unknown event ignored | PASS |
| 20 | Webhook `payment.failed` → order `failed` | PASS |
| 21 | Quota within-limit allowed / over-limit + unknown-feature rejected; consume debits | PASS |
| 22 | 10 concurrent `consumeQuota(1)` on remaining=5 → exactly 5 win, 5 rejected, used==grant | PASS |
| 23 | `recordAiUsage` debits once; replay → `duplicate:true`, no double charge; ledger row asserted | PASS |
| 24 | B usage never debits A | PASS |
| 25 | Lapsed trial + lapsed period → `expired`/unentitled via API and `checkQuota` (`subscription-expired`) | PASS |
| 26 | Member cancel 403; owner cancel → `cancelled`/unentitled | PASS |

**26/26 pass.**

## Frontend — `BillingTab.test.jsx` (9 tests, mocked `api.billing`, injected `window.Razorpay`)

Real-data render; server-plan identity marker; non-manager read-only;
unconfigured provider shows notice (no fake checkout); upgrade sends server
plan id → opens checkout with server order → verifies → success banner;
verify failure shows error, never success; modal dismiss re-reads state;
cancel confirms + refreshes; backend error renders instead of fake data.

**9/9 pass.**

## Regression totals

- Backend full suite: **96/96** (70 Phase 6+7 + 26 Phase 8), 0 fail.
- Frontend unit: **72/72** across 5 files (63 + 9), 0 fail.
- `tsc --noEmit` (billing added to checked surface): exit 0, no suppressions.
- `eslint src/ test/ scripts/`: exit 0.
- `vite build`: success. Backend: plain-JS service; CI equivalents
  (syntax, lint, typecheck, tests) all green.
- Migration 066 applied cleanly on the dev database (67 migrations up to date).
- No destructive migration; no Phase 6/7 file behavior altered (billing router
  is additive; `permissions.js` gained one grantable page key).
