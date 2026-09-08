# PHASE 8 — Billing Architecture (canonical)

## Ownership chain (org-centric)

```text
Organization
  └─ billing_subscriptions (1:1, UNIQUE organization_id, ON DELETE RESTRICT)
  │    └─ plan / status / provider ids / period / trial window
  ├─ billing_orders (1:N, org-owned, receipt UNIQUE, provider_order_id UNIQUE)
  ├─ organizations.ai_credits_granted / ai_credits_used (quota counters)
  └─ ai_usage_ledger (1:N, UNIQUE(org, inbound_message_id) idempotency)
       └─ user_id (nullable, "user where applicable"), agent/contact/model/tokens
```

There is no user-level subscription. The organization is the commercial
customer. Every billing read/write resolves the org from the authenticated
membership (`req.org`, forged `X-Org-Id` fails closed) — never from client
input, never from webhook payloads.

## Lifecycle

```text
Organization created
  → ensureSubscription() → plan=trial, status=trialing, trial_ends_at=now+14d,
     AI grant per catalog (placeholder) ..................... TRIAL
  → trial valid → entitled; trial past trial_ends_at → EXPIRED (not entitled)
  → POST /billing/create-order (owner/admin) → provider order + billing_orders
     row status=created, receipt UNIQUE ..................... ORDER
  → customer pays in Razorpay Checkout (public key only) .... PAYMENT
  → POST /billing/verify-payment: HMAC(order|payment) + amount/plan/order
     validation → atomic order paid + subscription ACTIVE ... ACTIVE
  → Razorpay webhook (order.paid / payment.captured|failed): same atomic
     activator, idempotent, org resolved from stored order .. (converges)
  → renewal = new order + verify (period extends, credits granted)
  → POST /billing/cancel (owner/admin) → CANCELLED (not entitled)
  → failed renewal/no payment → PAST_DUE (not entitled) → EXPIRED
  → abuse/non-payment ops action → SUSPENDED (not entitled; ops-only transition)
```

## Subscription states (canonical, stored lowercase)

| State | Meaning | Entitled |
|---|---|---|
| `trialing` | Trial plan within `trial_ends_at` | YES |
| `active` | Verified paid plan within `current_period_end` (or null = open) | YES |
| `past_due` | Payment failed / renewal missed | NO (fail closed) |
| `cancelled` | Owner/admin cancelled (kept to period end in UI only; access ends) | NO |
| `expired` | Trial lapsed or paid period lapsed with no renewal | NO |
| `suspended` | Ops action (abuse/non-payment). No self-service path in this phase | NO |
| `trial` (legacy alias) | Read as `trialing` for compatibility | YES iff window valid |

Schema CHECK (migration 066) is the superset
`{active,past_due,cancelled,trialing,expired,suspended,trial}` — additive,
existing rows stay valid. Effective state is computed by `subscriptionState()`
(status + `trial_ends_at`/`current_period_end` vs now), so stored values never
need a sweeper to stay truthful.

## Plan catalog (`backend/src/billing/plans.js`, server-side ONLY)

```text
Plan { id, name, pricePaise, currency:'INR', interval:'month'|null,
       trialDays, aiCreditsPerCycle, features[] }
trial | starter | growth | scale
```

**PRICING NOT YET FINALIZED.** No price exists anywhere in requirements, so
paid plans carry `pricePaise: 0` placeholders behind an explicit
`pricingFinalized: false` flag surfaced by `GET /billing/plans`. The client
never sends a price: order creation looks the amount up server-side, and
verification re-checks amount + plan against the catalog (forged-price orders
cannot verify). Trial AI grant (100 credits, 14 days) is likewise a
configuration placeholder, not a commercial term.

## Quota model (enforced dimension: AI credits)

```text
organization → plan → aiCreditsPerCycle (grant) → ai_credits_granted/used
  → remaining = granted − used → checkQuota / consumeQuota / recordAiUsage
```

- `checkQuota(orgId, 'ai_credits', n)`: resolves subscription → entitlement →
  remaining → `{ allowed, remaining, reason }`. Reads never mutate.
- `consumeQuota` / `recordAiUsage`: single transaction, `SELECT … FOR UPDATE`
  on the org row, debit via guarded `UPDATE … WHERE used+n <= granted`,
  ledger `INSERT … ON CONFLICT(org, inbound_message_id) DO NOTHING` with
  debit-refund on duplicate. Concurrent consumers serialize on the row lock;
  `read-then-write` races are structurally impossible.
- No other quota dimension (messages, seats, automations, broadcasts) has a
  numeric requirement in the product spec, so none is enforced. Adding one =
  catalog field + `quotas.js` case + tests (documented extension point).
- Frontend limits are display-only. All enforcement is backend.

## Razorpay flow (server-mediated, secret never leaves backend)

```text
Frontend → POST /billing/create-order → backend → Razorpay Orders API
Frontend ← { providerOrderId, amountPaise, currency, publicKey, plan } (SAFE ONLY)
Frontend → Razorpay Checkout (checkout.js, public key + order_id)
Razorpay → Frontend handler { razorpay_payment_id, razorpay_signature }
Frontend → POST /billing/verify-payment → HMAC-SHA256(order|payment, SECRET)
  → amount/plan/order checks → atomic activate (idempotent)
Razorpay → POST /v1/billing/webhook/razorpay (raw-body HMAC, webhook secret)
  → org from stored order → same atomic activator (replay/duplicate safe)
```

Without `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`, order creation returns
`503 billing-unavailable` (documented, UI shows "billing not configured") —
never a fake order. Verification is pure HMAC and always enforced.

## Billing authorization (existing role model, no second system)

- Read (`plans`, `status`): any org member.
- Write (`create-order`, `verify-payment`, `cancel`): org `owner`/`admin`
  membership role only. Global `admin`/`bda_sales`/`viewer` roles are
  orthogonal and confer no billing power by themselves.
- Webhook: public, HMAC-only (standard); org resolved from stored order.

## Expiry semantics (implemented, minimal)

- Trial expiry: `trialing` + now > `trial_ends_at` → effective `expired`,
  not entitled. No grace.
- Paid expiry: `active` + `current_period_end` passed → effective `expired`.
- `past_due`: set by failed webhook/renewal; not entitled (fail closed).
- `cancelled`: immediate loss of entitlement (period-end access is an
  UNRESOLVED business decision — see below).
- Success/renewal: `active`, `current_period_end` extended by interval,
  AI grant added.

## Unresolved business decisions (documented, NOT guessed)

1. Paid-plan prices, intervals, and credit grants (placeholders in catalog).
2. `past_due` grace window (currently zero — fail closed).
3. Cancelled-subscription period-end access (currently immediate).
4. Seat/message/automation quota numbers (no enforcement added).
5. `suspended` self-service/ops flow (no transition path in this phase).
6. Refunds/proration (no endpoint).
7. Multi-currency (INR only).
