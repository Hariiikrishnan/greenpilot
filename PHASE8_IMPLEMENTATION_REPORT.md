# PHASE 8 — Implementation Report (Billing, Subscriptions & Organization Quotas)

## 1. Previous architecture (forensic summary)

Greenfield. Beyond two empty schema stubs (`billing_subscriptions`,
`ai_usage_ledger` in migration 063) there was no billing code, route, plan,
price, credential, SDK reference, UI, or test — Phase 5 recorded
"Billing/quotas — REBUILD (greenfield; none exists)". Full evidence table:
`PHASE8_BILLING_FORENSIC_REPORT.md`.

## 2. Final architecture

```text
Organization ─┬─ billing_subscriptions (1:1, plan/state/period/trial window)
              ├─ billing_orders (1:N, receipt UNIQUE, provider_order UNIQUE)
              ├─ organizations.ai_credits_granted/used (quota counters)
              └─ ai_usage_ledger (UNIQUE(org, inbound_message_id), +user_id)

 Plans (server catalog, placeholders) → create-order (owner/admin, 503 w/o
 provider) → Razorpay Checkout (public key only) → verify-payment (HMAC +
 amount/plan/order checks → atomic activate, idempotent) → ACTIVE
 Webhook (raw-body HMAC, org from stored order) → same atomic activator.

 Quotas: checkQuota (verdict) / consumeQuota / recordAiUsage — row-locked
 transactions, guarded debits, ledger-dedupe with refund-on-replay.
```

Canonical docs: `PHASE8_BILLING_ARCHITECTURE.md` (model, states, quotas,
unresolved decisions), `PHASE8_BILLING_API_CONTRACT.md` (endpoints).

## 3. Subscription model

`billing_subscriptions` + `subscriptionState()` effective-state computation
(`trialing/active/past_due/cancelled/expired/suspended/trial`; unknown →
expired fail-closed). Migration 066 expands the CHECK to the superset
non-destructively and adds `trial_ends_at`. `ensureSubscription` seeds trial
rows + trial AI grant idempotently.

## 4. Organization ownership

`billing_orders.organization_id` (RESTRICT) + pre-existing subscription
UNIQUE-org. All reads/writes scope by `req.org`; wrong-order and forged-org
share one 404; B-on-A access is 403 at the tenant layer (test-proven).

## 5. Plan model

`src/billing/plans.js`, server-side only: trial/starter/growth/scale with
price/interval/trialDays/AI-grant/features. **PRICING NOT YET FINALIZED** —
paid prices are explicit `0` placeholders behind `pricingFinalized:false`
(surfaced to UI). Client never sends prices; verification re-checks equality.

## 6. Entitlement model

Entitled = `trialing` (window valid) or `active` (period valid). Everything
else (past_due/cancelled/expired/suspended/unknown) is unentitled; quota
functions throw `subscription-<state>` (403). No grace windows invented.

## 7. Quota model

Enforced dimension: AI credits (the only schema-backed dimension; seat/
message/automation numbers don't exist in requirements and were NOT
invented). `checkQuota` (read-only) + `consumeQuota` + `recordAiUsage`
(transactional: `FOR UPDATE` + guarded `UPDATE`, ledger `ON CONFLICT DO
NOTHING` with refund-on-replay). 10-way concurrency test proves exactness.

## 8. AI usage ledger integration

Org-owned (pre-existing), plus nullable `user_id` (066) for "user where
applicable". `recordAiUsage` (org/user/agent/contact/message/model/tokens/
cost/timestamp) is implemented + tested; **no engine calls it yet — Phase 9
wiring is explicitly deferred**, no AI behavior changed.

## 9. Razorpay flow

`src/billing/razorpay.js`: Orders API via Basic auth (in-memory only),
HMAC-SHA256 payment + webhook verification (timing-safe), generic error
mapping. Secret/webhook-secret never leave the backend; only KEY_ID reaches
the client. Absent credentials → 503 (never fake).

## 10. Order creation / payment verification / webhooks

Per contract doc: server-resolved plan+amount, per-org advisory lock,
30-min open-order reuse, HMAC + amount/plan/order validation, atomic
paid-transition (`WHERE status='created'`, single winner, replay-safe),
webhook HMAC over `req.rawBody` with stored-order org resolution and
`payment.failed` handling. Browser callbacks prove nothing alone.

## 11. Billing authorization

Reads: any member. Writes: org `owner`/`admin` (existing membership roles;
`requireBillingManager`). Global admin/sales roles confer nothing alone.
`admin-settings:billing` page key added as grantable (admins see it by
default; sales do not).

## 12. Quota concurrency protection

Row-lock serialization + guarded debit; proven by the 5-of-10 race test and
the refund-on-replay test. No read-check-write anywhere.

## 13. Frontend integration

`api.billing.*` + Settings → Billing tab (`BillingTab.jsx`): real status/
plans/usage, server-identity plan markers, placeholder-price notice,
unconfigured notice, checkout.js upgrade → verify → banner, dismiss
re-reads state, failure never claims success, cancel with confirm,
non-managers read-only. No UI redesign (same visual system). One real bug
found by tests and fixed: post-verify refresh wiped the result banner.

## 14. Tests — backend 96/96, frontend 72/72 (detail: `PHASE8_BILLING_TEST_REPORT.md`)

## 15. Builds

`tsc` ✅ (billing in checked surface) · `eslint` ✅ · `vite build` ✅ ·
migration 066 applied (67/67) · full suites green.

## 16. Unresolved business decisions (NOT guessed)

Prices/intervals/grants; past_due grace (zero); cancelled period-end access
(immediate); seat/message/automation quotas (none); suspended ops flow;
refunds/proration; multi-currency. See architecture doc §"Unresolved".

## 17. Security findings

No secret reaches the frontend (response bodies asserted secret-free);
safe error mapping; webhook fail-closed without secret; no client-trusted
price/org/entitlement; idempotent money paths (no double grant/subscription).
No currently-committed secret found — historical scrub remains separate and
is NOT claimed resolved.

## 18. Historical secret-scrub status

Unchanged: separate task, not resolved by this phase, no secrets printed.

---

**PHASE 8 STATUS: COMPLETE**
