# PHASE 8 — Billing API Contract (canonical `/api/v1/billing/*`)

Auth: session cookie (`forgecrm_token`) on every call. Org: `req.org` from
authenticated membership (`X-Org-Id` suggestion honored only with membership;
forgery → 403 from the tenant layer before any handler). Roles: reads = any
member; writes = org `owner`/`admin` (else 403 `billing-forbidden`).
Idempotency, ownership, and error rules are per-endpoint below.

Conventions: amounts are integer **paise**; times ISO-8601; `organizationId`
echoes the authorizing org. Error bodies are `{ error, code? }` — never
provider secrets, raw provider bodies, or foreign-org data. `503
billing-unavailable` = provider credentials absent (fail closed, never fake).

## GET /billing/plans (member)

Response `200`: `{ plans: [{ id, name, pricePaise, currency, interval,
trialDays, aiCreditsPerCycle, features[], pricingFinalized: false,
orderable }], pricingFinalized: false }`. `orderable=false` for `trial`.

## GET /billing/status (member)

Response `200`:
```json
{
  "organizationId": "<uuid>", "plan": "starter", "planName": "Starter",
  "state": "active", "entitled": true,
  "trialEndsAt": null, "currentPeriodEnd": "2026-..",
  "usage": { "granted": 1100, "used": 31, "remaining": 1069 },
  "canManageBilling": true, "providerConfigured": true,
  "pricingFinalized": false
}
```
`state` ∈ `trialing|active|past_due|cancelled|expired|suspended`
(computed server-side from status + windows). First call also ensures the
trial subscription + trial AI grant (idempotent).

## POST /billing/create-order (owner/admin) — body `{ plan }`

- `400 unknown-plan` — plan id not in the server catalog.
- `400 trial-no-order` — trial needs no order.
- `503 billing-unavailable` — provider not configured.
- `502 provider-unreachable|provider-order-failed` — provider call failed.
- `200 { reused:true, ... }` — open `created` order for same org+plan (<30
  min) returned instead of minting a duplicate.
- `201 { providerOrderId, receipt, amountPaise, currency, plan, publicKey }`
  — `publicKey` is the Razorpay KEY_ID (public by design). No secret fields.

## POST /billing/verify-payment (owner/admin)

Body `{ providerOrderId, providerPaymentId, signature }` (all required,
else `400`). Steps: org-scoped order lookup (`404 order-not-found` covers
wrong-order AND forged-org identically) → amount/plan re-check vs catalog
(`400 order-plan-mismatch`) → HMAC-SHA256(order|payment) check
(`403 invalid-signature`) → atomic activate. Response `200`:
`{ ok:true, alreadyProcessed, plan, state, entitled, currentPeriodEnd,
usage:{...} }`. Replays return `alreadyProcessed:true` with identical grants
(single credit — no double entitlement).

## POST /billing/cancel (owner/admin)

Response `200 { ok:true, plan, state:'cancelled', entitled:false }`.
Immediate loss of entitlement (period-end access undecided — see architecture).

## POST /v1/billing/webhook/razorpay (PUBLIC, HMAC-only)

Headers: `X-Razorpay-Signature` = HMAC-SHA256(webhook secret, raw body).
Failure → `403`. Events: `order.paid` / `payment.captured` → same atomic
activator as verify (idempotent; org from the STORED order, payload notes
untrusted); `payment.failed` → order `failed`; anything else → `200
{ ok:true, ignored:true }`. Handler always answers 2xx with static bodies
(provider retries on non-2xx; error text stays server-side).

## Quota/usage (no separate HTTP surface in this phase)

Usage is read via `GET /billing/status` (`usage.{granted,used,remaining}`).
Enforcement points are backend functions (`checkQuota`/`consumeQuota`/
`recordAiUsage` in `src/billing/quotas.js`): `403 quota-exhausted`,
`403 subscription-<state>`, `400 unknown-feature`. Phase 9 calls
`recordAiUsage` per AI run (idempotency key = org + inbound message id).
