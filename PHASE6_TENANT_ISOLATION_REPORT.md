# PHASE 6 — Tenant Isolation Report (Step 12)

> Suite: `backend/test/tenantIsolation.test.js` (DB-backed; skips cleanly with
> `t.skip` when no database is reachable). Self-provisions schema via
> `runMigrations`. Fixture Org A vs Org B torn down by TAG (zero leftovers
> verified). Result: **12/12 pass** (full backend suite 48/48).

## Coverage matrix (A × B)

| Assertion | Layer | Result |
|---|---|---|
| A cannot assert membership in B org (vice versa); A resolves own | service (`assertMembership`) | pass |
| A cannot read B row via `assertOrgRow` (→ null/404); A reads own — contacts, messages, conversations, agents, automations, ledger, WA accounts (7 tables) | service (`scope.js`) | pass ×7 |
| Org-scoped lists return only own rows (messages, conversations, agents, ledger) | SQL | pass |
| Cross-org UPDATE/DELETE affect 0 rows; victim data byte-identical | SQL | pass |
| `tenantJobAllowed`: same-org + legacy-unstamped pass; A×B denied both directions | worker guard (pure; shared by send + agent workers) | pass |
| Ledger reimbursement check: A has exactly its row, B exactly its own (quota attribution) | SQL | pass |

## Worker paths (background)
- Send worker: `processJob` re-resolves account creds and throws `skipRetry` on
  explicit job-vs-account mismatch (verified by guard unit test; live Meta send
  not exercised — no credentials in test).
- Agent worker: `processJob` re-resolves agent→account org and returns
  `refused-tenant-mismatch` (completes, no retry) on mismatch.
- Automation Delay jobs ride `enqueueSend` → same stamping + guard.
- Media queue: unchanged content pipeline; org scoping rides the message row
  (staged: per-org storage paths).

## HTTP/API paths (wire — `backend/test/tenantHttp.test.js`, 7/7 pass)
Real Express app on an ephemeral port (exported without boot side effects;
`require.main === module` guard added to `index.js`):
- unauthenticated `/api/auth/me` → 401;
- A↔B org member lists → 403 both directions, own → 200;
- forged `X-Org-Id` → **403 from the tenant layer** (error handler now honors
  `err.status`; 500 reserved for real failures);
- dual-org member cross-reading accounts → **404** (no existence leak), own → 200;
- B removing A from A's org → 403, membership intact;
- v1 webhook with unknown org → 404.
Redis handles from queue modules are drained in teardown so the runner exits.

## Billing isolation
- `billing_subscriptions` UNIQUE per org; ledger quota attribution tested above;
  provider-side attribution has no code yet (B3) — nothing to leak.
