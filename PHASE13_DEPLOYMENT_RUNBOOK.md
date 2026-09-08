# PHASE13 — Deployment Runbook (reproducible checklist)

Target topology: single replica — Postgres 15 + Redis 7 + backend (Node 20)
+ frontend (nginx) + Caddy (auto-HTTPS). Multi-replica boot is
migration-safe (advisory lock), but Socket.IO is single-process by decision:
scale vertically for the first deployment.

## Preconditions (infrastructure dependencies, external)

- Host with Docker Compose v2.24+, DNS `DOMAIN` → host, ports 80/443 open.
- Meta app with webhook URL `https://<DOMAIN>/api/v1/webhooks/whatsapp/:orgId`.
- Razorpay + AI provider keys only if billing/AI launch in scope (else the
  app boots with those integrations reporting `off`).

## Deploy

1. **Clean checkout** — `git clone <repo> && git checkout <tag>` (deploy tags,
   never branches).
2. **Install** — images build in CI (`docker-publish.yml` → GHCR on release)
   or `docker compose -f docker-compose.yml -f docker-compose.prod.yml build`.
3. **Environment injection** — root `.env` (`POSTGRES_PASSWORD`,
   provider keys, see `PHASE13_PRODUCTION_ENV_CONTRACT.md`); `chmod 600`
   `backend/.env` if used. Production requires
   `DATABASE_URL` + `REDIS_URL` + `CORS_ORIGIN` (boot refuses without them).
4. **Database connection** — `docker compose up -d forgecrm-db redis`;
   wait for both `healthy`.
5. **Migrations** — automatic on backend boot (ledger + advisory lock);
   watch logs for `[migrate] applied` / `up to date (N migrations)`.
6. **Backend build/start** — `up -d forgecrm-backend`; require
   `[boot] env=production …` banner; no `[Fatal]`.
7. **Frontend build** — static nginx image; no runtime env needed
   (same-origin `/api`).
8. **Worker startup** — banner `workers=media,send,agent,automation`;
   each logs `worker started` with concurrency.
9. **Readiness checks** — backend `/ready` → `{"ok":true,
   "checks":{"db":true,"migrations":true,"redis":true}}`; compose reports
   backend `healthy`; frontend serves `/`.
10. **Webhook configuration** — per-org URL in Meta dashboard; verify with
    the GET handshake, then a live inbound message (see smoke test).
11. **Smoke test** — register → org → onboarding → WhatsApp status
    `connected` → invite/accept → CRM note/call/follow-up → automation
    test-run → billing plans/status. Record results per §22 list.
12. **Rollback procedure** — re-deploy previous image tag; DB rollback =
    restore pre-deploy backup first (migrations are additive; forward-fix
    preferred). Never delete the `secrets`/`pgdata` volumes on rollback.

## Production overlay

`DOMAIN=chat.example.com docker compose -f docker-compose.yml
-f docker-compose.prod.yml up -d` (Caddy terminates TLS, `:8080` unpublished,
`CORS_ORIGIN=https://$DOMAIN` injected).

## First-boot operator notes

- Create the admin via the setup wizard (or `ADMIN_EMAIL`/`ADMIN_PASSWORD`
  seed — rotate immediately; installer default is documented-weak).
- Set `META_APP_SECRET` or inbound webhooks stay rejected (fail-closed).
- Override compose `POSTGRES_PASSWORD`; keep `secrets` volume backups.
