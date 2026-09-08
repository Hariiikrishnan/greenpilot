# PHASE13 — Launch Readiness Report

## Verification summary (exact results)

| Check | Result |
|---|---|
| Backend `npm test` | **201/201, three consecutive full runs** (baseline 191 + 10 new); one transient parallel-timing flake observed in 6 runs (crm before-hook vs absent Redis), passes alone + all reruns |
| Backend `npm run lint` | PASS |
| Backend `npm run typecheck` | PASS |
| Frontend `vitest run` | 95/95 PASS |
| Frontend `vite build` | PASS (pre-existing chunk-size warning only) |
| Migrations | 71/71 apply (`up to date (71 migrations)`); new: none required in Phase 13 (no schema change) |
| Tenant/auth/queue/webhook/billing/AI/automation suites | all green, unmodified semantics |

## Smoke test (§22, production-like wire environment — recorded)

Account register/login/logout/password-change ✓ · workspace create/settings ✓ ·
invite/lookup/accept/revoke + email-match + single-use ✓ · contact CRUD/status/
assignment/note/call/follow-up ✓ (Phase 11 suite) · WhatsApp connect-path
(credential check), inbound persist + org stamp, unknown-number skip,
status-receipt advance, realtime room emit ✓ (wire-asserted; Meta-live send
needs provider creds — infra-dependent) · AI qualification + ledger +
quota-refusal ✓ (Phase 9 suite) · automation trigger/action/delay/retry +
depth/visited guards ✓ (Phase 10 suite) · billing plans/order/verify/
subscription-state/quota ✓ (Phase 8 suite) · `/health` + `/ready` + logout
cookie clearing + auth throttling ✓ (new).

## Findings fixed in Phase 13 (files changed)

- `routes/dashboard.js` — full org scoping (aggregates, drill-downs, admin sections, connected-number resolution).
- `routes/messages.js` (`GET /numbers`) — org scoping + `LIMIT 100`.
- `routes/webhook.js` — fail-closed without `META_APP_SECRET` (explicit dev
  opt-out); unknown-number skip (no NULL-org injection); status-receipt org
  confinement; contact upsert org-guarded; downstream triggers/media only for
  persisted records; honest `stored` counts.
- `queue/sendQueue.js` — origin updates org-scoped (steps via parent execution).
- `queue/mediaQueue.js` + `services/mediaDownloader.js` + `routes/media.js` —
  org carried through download jobs, lookups/updates confined.
- `realtime/socket.js` — generic `join` revalidates membership live.
- `src/index.js` — `trust proxy` (private ranges), auth brute-force limiter
  (30/15min), `/ready` (PG+migrations+Redis, leak-free), request IDs, 500s
  carry `requestId`, production env fail-fast, startup banner (booleans only),
  complete shutdown (`server.close` await, `pool.end()`, 25s force timeout,
  `unhandledRejection`/`uncaughtException` guards).
- `src/auth.js` — cookie clear mirrors creation attrs; login-failure logging
  (email only).
- `src/middleware/access.js` — `adminOrOrgManager` (used by WhatsApp
  connect/update/delete + CRM bootstrap; precedent: billing manager gate).
- `frontend/nginx.conf` — forwarded headers; `TemplateBuilderPage` — dropped
  success-path console payload.
- Docker: backend `HEALTHCHECK` (`/ready`), compose backend healthcheck +
  frontend `depends_on: healthy`, sample compose fixed (root context, secrets
  volume, healthcheck).
- Tests added: `productionHardening.test.js` (7 wire), `requestId.test.js`
  (3 unit); `tenantHttp.test.js` updated to fail-closed webhook contract.

## Launch classification

### PRE-LAUNCH REQUIRED (operational, owner: deployer)
1. Configure host backups (`pgdata` + `secrets` + media) per runbook — nothing
   in-repo does this automatically.
2. Set `META_APP_SECRET` + per-org webhook URLs in Meta dashboard (else inbound
   stays rejected by design).
3. Override `POSTGRES_PASSWORD`, rotate installer `ADMIN_PASSWORD`, `chmod 600`
   env files, persist `secrets` volume.

### BUSINESS DECISION (owner: founder/product)
4. Final pricing is placeholder zeros (`pricingFinalized:false` surfaced) —
   cannot take real money until catalog + Razorpay live keys are set.

### INFRASTRUCTURE DEPENDENCY (external)
5. TLS/DNS host, Redis + Postgres 15 availability, Meta app review, mail
   path for invite links (currently manual link share).

### POST-LAUNCH HARDENING (explicit ownership, safe to defer)
6. JWT refresh rotation/revocation (theft window 24h; deactivation already immediate).
7. Playwright E2E in CI (config hardcodes lab IP; backend wire coverage exists).
8. Remove automation legacy `OR organization_id IS NULL` after backfill approval.
9. Per-org contacts uniqueness (only with real conflict evidence; guard in place).
10. Structured log shipper / metrics (in-app correlation IDs ready).

### BLOCKER
None remaining in the repository.

## Known limitations (restated briefly)

Single-process Socket.IO (no adapter by decision); legacy dual-reads during
backfill transition; contacts global uniqueness; dev-fallback secret literals
neutralized in prod entrypoint; `forgecrm_*` internal names kept for compat.

**PHASE 13 STATUS: COMPLETE**
