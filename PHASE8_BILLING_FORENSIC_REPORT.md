# PHASE 8 — Billing Forensic Report

Date: Phase 8 execution. Method: full-tree grep + schema inspection. Verdicts
below are evidence-backed, not assumed.

## Headline

**No billing implementation exists beyond two empty tables.** Phase 5's own
evolution map already recorded this: *"Billing/quotas — REBUILD (greenfield;
none exists)"* (`PHASE5_FORGECHAT_TO_GREENPILOT_EVOLUTION_MAP.md:123-125`).
Every billing behavior in Phase 8 is therefore greenfield construction on top
of the schema stubs — there is no existing logic to "verify", only stubs to
honor and gaps to fill.

## Inventory

| Area | Finding | Evidence |
|---|---|---|
| Billing routes | NONE | No `routes/billing*`, no `/billing` path in `src/` |
| Billing controllers/services | NONE | No `services/*billing*`, no billing helpers |
| Razorpay integration | NONE | `razorpay` (any case) appears nowhere in `backend/src`, `backend/package.json`, `backend/.env.example`, or `frontend/src` payment code |
| Payment/order creation | NONE | — |
| Payment verification | NONE | — |
| Billing webhooks | NONE | Only Meta WhatsApp + Google OAuth webhooks exist |
| Subscription model (code) | NONE | `billing_subscriptions` is never read/written by any `src/` file |
| Quota model (code) | NONE | No `checkQuota`/entitlement/gating code anywhere |
| AI usage ledger (code) | TABLE ONLY | `ai_usage_ledger` written only by `test/tenantIsolation.test.js` fixtures; zero producers/consumers in `src/` |
| Frontend billing pages | NONE | No Billing/Pricing/Subscription component, route, or nav entry |
| Plan definitions | STUB ONLY | `organizations.plan DEFAULT 'trial'`; never branched on in `src/` |
| Entitlement checks | NONE | — |
| Environment variables | NONE | No `RAZORPAY_*`/`BILLING_*`/`PLAN_*`/`CREDIT_*` in `.env.example` |
| Frontend payment SDK | NONE | No `checkout.razorpay.com` reference anywhere |
| Billing tests | NONE | No `test/*bill*`, no billing assertions outside ledger org-scoping |
| AI credit columns (code) | READ-ONLY | `ai_credits_granted/used` selected in `tenancy/organizations.js:45,67` for session display; never debited/credited/enforced |

## Schema stubs that DO exist (and their exact shape)

`db/migrations/063_new_tenant_tables.sql`:

- `billing_subscriptions` — `id UUID PK`, `organization_id UUID NOT NULL UNIQUE
  → organizations ON DELETE RESTRICT`, `plan TEXT DEFAULT 'trial'`,
  `status TEXT DEFAULT 'active'`, `provider`, `provider_customer_id`,
  `provider_subscription_id`, `current_period_end`, timestamps.
  `CHECK (status IN ('active','past_due','cancelled','trialing'))`.
  Observed quirks: default is `plan='trial'` + `status='active'` (not
  `'trialing'`); states `expired`/`suspended`/`trial` are missing from the
  CHECK; no order/payment/audit table; no subscription history.
- `ai_usage_ledger` — org-owned (`ON DELETE RESTRICT`), `agent_id → agents
  NULL ON DELETE SET NULL`, `contact_number`, `inbound_message_id NOT NULL`,
  `model`, `tokens_in/out`, `cost_credits DEFAULT 1`,
  `UNIQUE (organization_id, inbound_message_id)` (idempotency key) +
  `(org, created_at)` index. No `user_id` column, no period/window column.
- `organizations` (`059`) — `plan DEFAULT 'trial'`,
  `ai_credits_granted/used DEFAULT 0`; member roles `owner/admin/member`
  (`organization_members_role CHECK`).

## Adjacent systems reused (not billing, but load-bearing)

- Tenant middleware: `authMiddleware → resolveTenant`; forged `X-Org-Id`
  fails closed (`middleware/tenant.js`, `tenancy/organizations.js`).
- Org role model: `owner/admin/member` with owner-only remove + last-owner
  protection (`routes/organizations.js`) — billing write-auth builds on this.
- Global user roles: `admin/bda_sales/viewer` (`permissions.js`) — orthogonal
  to org billing authority; billing must NOT conflate the two.
- Queue jobs carry `organizationId` + `tenantJobAllowed` re-validation
  (`queue/sendQueue.js`, `tenancy/scope.js`) — pattern reused for quota debit.
- Razorpay-looking strings in `frontend/.../AutomationBuilderView.jsx`
  (`integration: "razorpay"`, webhook event pickers) are **mock UI copy for an
  automation trigger picker**, not a payment integration. No secret, no SDK.

## Gaps Phase 8 must close (no existing behavior to preserve)

1. No order/payment tables → new additive migration `066_billing_orders`.
2. Status CHECK missing `expired`/`suspended` → superset CHECK migration
   (non-destructive; existing four values stay valid).
3. No plan catalog, no prices anywhere → server-side catalog with
   **PRICING NOT YET FINALIZED** placeholders (nothing in requirements to copy).
4. No Razorpay credentials/URLs → provider module calling Razorpay Orders API
   only when `RAZORPAY_KEY_ID/SECRET` are set; otherwise `503
   billing-unavailable` (never a fake success).
5. No ledger producer → `recordAiUsage` helper (transactional ledger +
   credit debit), engine wiring deferred to Phase 9.
6. No billing UI → minimal real-data Billing tab (no fake success states).
7. `ai_usage_ledger` lacks `user_id` → nullable additive column (needed for
   "user where applicable" without rewriting history).

## Secret-scrub status (historical item)

Current-tree grep for `razorpay`, live secret patterns, and `checkout` SDK
references finds **no committed secret**. The historical scrub remains a
separate task; nothing in this audit resolves it, and no secret is printed here.
