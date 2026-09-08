# PHASE13 — Production Forensic Report

Audited 2026-09-05: backend, frontend, 71 migrations, queues/workers, Redis/PG
usage, auth, tenancy, WhatsApp/Meta webhook, AI/automation execution,
Socket.IO, billing, media, env/logging/errors, Docker/CI, health, lifecycle,
seeds, scripts, builds. Sub-agent audits (secrets, lifecycle, tenant/money)
verified firsthand for every HIGH+ item below. Nothing fixed before this
report was written.

## CRITICAL

None. No bypassable auth, no exposed production secrets in repo/history, no
billing activation without verification, no unbounded automation loops, no
destructive migrations.

## HIGH

1. **Dashboard aggregates have no tenant boundary** (`backend/src/routes/dashboard.js:35-71,79-535`).
   `applyScope()` filters only `wa_number` (+ per-user assignment); never
   `organization_id`. `getConnectedWa()` is global. Any member of org B sees
   org A's counts on shared numbers; `automations` branch (`527-532`) is a
   global `chatbots WHERE status='active'`. Real cross-tenant read → fix with
   org predicate (dual-read) on every aggregate.
2. **No readiness probe; `/health` verifies nothing** (`backend/src/index.js:132`).
   Load balancers route to processes with dead PG/Redis. No `/ready`, no
   image/service `HEALTHCHECK` (only db/redis have them) → add readiness
   checking PG + migrations watermark + Redis, keep `/health` as liveness.
3. **No proxy trust + weak global-only rate limiting** (`backend/src/index.js:53-129`).
   No `trust proxy` (nginx/Caddy in front) so `req.ip` keys collapse; no
   auth-specific limiter — login/register share 600 req/min. Add
   `trust proxy`, forwarded headers in nginx, strict auth limiter.
4. **Incomplete graceful shutdown** (`backend/src/index.js:320-332`): PG pool
   never `pool.end()`-ed, `server.close` not awaited, no force timeout, no
   `unhandledRejection`/`uncaughtException` handling → in-flight writes can
   be cut. Queues/realtime close correctly; PG + timeout + crash guards missing.

## MEDIUM

5. **`GET /numbers` has no org filter** (`backend/src/routes/messages.js:170-225`;
   contrast org-scoped `GET /contacts`) → cross-tenant enumeration of
   numbers/counts/unreads. Fix with dual-read org scope.
6. **Webhook fail-open without `META_APP_SECRET`** (`backend/src/routes/webhook.js:277-283`):
   `sig===null` only warns; forged inbound rows land in victim org inbox.
   Fix: 403 unless explicit `ALLOW_UNVERIFIED_WEBHOOKS=true` (dev escape hatch).
7. **Legacy `POST /webhook/whatsapp` persists unknown numbers as NULL-org rows**;
   contacts upsert `ON CONFLICT(wa_number,contact_number)` is global (no org)
   → cross-tenant profile clobber + orphan rows. Fix: reject unknown numbers
   on legacy route; scope upsert by org.
8. **`clearCookie` drops attributes** (`backend/src/auth.js` ×6): prod
   Secure-cookie logout may leave the cookie client-side. Fix: mirror
   `httpOnly/sameSite/secure/path`.
9. **Redis de-facto required but failure mode inconsistent**: require-time
   connections, infinite reconnect, only media enqueue has fallback; send/agent/
   automation `add()` throws to caller (webhook/send fails), orphan `running`
   row until 15-min sweeper. Fix: document Redis REQUIRED; uniform enqueue
   error mapping (503, no duplicate side effects).
10. **JWT 24h, no rotation/revocation** (mitigated by per-request
    role/`is_active` re-check; theft window remains). Document as
    post-launch hardening; do not weaken.
11. **Unstructured logs, no correlation IDs** (~100 `console.*`, no
    `X-Request-Id`, no access log). Add minimal request-id middleware +
    structured event log for auth/webhook/queue/AI/automation/billing/5xx.
12. **E2E excluded from CI** (`test = unit && e2e` but CI runs unit only;
    `vite.config.e2e.js` hardcodes lab IP). Wire E2E equivalent already runs
    backend-side; fix config or document.
13. **Legacy global automation dual-read** (`automation/service.js:280`
    `OR organization_id IS NULL`) can fire one org's automation for another
    during transition. Scope to org after backfill; short-term: require org.
14. **Weak defaults**: compose `POSTGRES_PASSWORD:-forgechat`, installer
    `Admin@123456` (internal-only DB, documented override — enforce at deploy).

## LOW

15. Socket generic `join` uses connection-time rooms (no fresh lookup;
    `join-org` is safe) → revalidate or restrict `org:*` joins.
16. `mediaQueue` carries only `{messageId}` (no org predicate in downloader);
    `sendQueue` origin updates lack org predicate (needs Redis forgery to
    exploit) → carry/check org.
17. `verifyToken` plaintext to instance-admins (by design; keep + audit).
18. PII-adjacent log values (phone numbers); Razorpay error blob slice(0,300);
    `mcp-server/.env.example` prod hostname; PAT-in-URL doc pattern;
    `docker-compose.sample.yml` stale; backend image uses `npm install` not
    `ci`; frontend zero env configurability (same-origin design — fine);
    dev-fallback secret literals (neutralized by `instanceSecrets` in prod
    entrypoint); test-only low-entropy fixtures (never prod).

## Deliberately NOT changed (working systems preserved)

Billing activation/quotas, AI ledger ordering, automation depth/loop guards,
socket handshake/rooms, migration runner (ledger + advisory lock), dual-read
strategy, Vite same-origin/no-`VITE_*` isolation (frontend cannot receive
backend secrets — verified), pricing placeholders (business decision, §24).
