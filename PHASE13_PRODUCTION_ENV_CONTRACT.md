# PHASE13 — Production Environment Contract (authoritative)

Single source of truth for configuration. Startup enforces the REQUIRED set
in production (`start()` throws → `exit(1)`); development/test only warn.
The frontend bundle receives **zero** backend secrets (verified: no
`VITE_*`/`import.meta.env` usage, no `define`, same-origin nginx proxy).

## REQUIRED in production (boot refuses without these)

| Variable | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection | Full URL; pool is `pg` defaults otherwise. |
| `REDIS_URL` | BullMQ queues + workers (send/agent/automation/media) | **REQUIRED infra** — enqueue paths fail without it; `/ready` gates on it. |
| `CORS_ORIGIN` | Exact app origin, e.g. `https://chat.example.com` | Credentials + cookies depend on it. |
| `NODE_ENV=production` | Secure cookies, masked errors, HSTS | Compose/Dockerfile set it. |

## Backend-only secrets (NEVER frontend, never logged, never in images)

| Variable | Purpose | Default behavior if unset |
|---|---|---|
| `JWT_SECRET` | Session signing | Auto-generated strong + persisted (`instance.json`, `chmod 600`) — **back up the `secrets` volume**. |
| `FORGECRM_ENCRYPTION_KEY` | WhatsApp token encryption (AES-256-GCM) | Same auto-generate/persist. **Rotation = re-encrypt; loss = tokens unreadable.** |
| `META_APP_SECRET` | Webhook HMAC verification | **Fail-closed**: inbound webhooks 403 unless `ALLOW_UNVERIFIED_WEBHOOKS=true` (local dev only). |
| `RAZORPAY_KEY_ID` / `_SECRET` / `_WEBHOOK_SECRET` | Billing (only KEY_ID ever reaches clients) | Billing endpoints inert without them. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | AI providers, server-side only | AI features report unavailable. |
| `POSTGRES_PASSWORD` | Compose-internal DB credential | Override default `forgechat` in real deployments; DB has no host port. |
| `ADMIN_PASSWORD` (+ `ADMIN_EMAIL`) | First-boot admin seed only | Change immediately; installer default is documented-weak. |

## WhatsApp / Meta

`META_API_VERSION` (default `v21.0`), `META_ACCESS_TOKEN` (fallback only),
`META_WEBHOOK_VERIFY_TOKEN` (local-dev verify, installer-generated),
per-account tokens encrypted per-row (never in env).

## URLs / webhooks / cookies

- `APP_URL` ≡ `CORS_ORIGIN`. Webhook URL: `<APP_URL>/api/v1/webhooks/whatsapp/:orgId`
  (canonical) — configure this exact URL in the Meta app dashboard.
- Cookies: `HttpOnly`, `SameSite=strict`, `Secure` in production, 24h JWT;
  deletion mirrors creation attributes (logout actually clears).
- CORS: `CORS_ORIGIN` + `CORS_ORIGINS` (csv) + `http://localhost:5173` +
  localhost/127.0.0.1 any-port (documented local carve-out); no wildcards.

## Optional / tuning

`PORT` (3011 compose / 3001 local default), `HTTP_PORT`, `DOMAIN`,
`MEDIA_DIR`, `MEDIA_TRANSCODE_AUDIO`, `SEND_RATE_MAX/_DURATION_MS`,
`TEMPLATE_SYNC_INTERVAL_MS`, `LEAD_SOURCE_CATEGORY`, `MIGRATIONS_DIR`,
`GREENPILOT_DATA_DIR`/`FORGECHAT_DATA_DIR`, queue `*_CONCURRENCY/*_ATTEMPTS/*_BACKOFF_MS`,
`META_WEBHOOK_VERIFY_TOKEN`.

## Development-only / test-only (never production)

`ALLOW_UNVERIFIED_WEBHOOKS=true` (local webhook dev), `ADMIN_EMAIL`/
`ADMIN_PASSWORD` installer defaults, CI `POSTGRES_PASSWORD=ci`, test
fixtures (`*-test-secret`, `unit-secret`), Playwright lab IPs.

## Worker-only / infra

Redis: BullMQ for all four queues (no Redis → enqueue fails loudly, no
silent drops except the media inline fallback which logs). Postgres 15,
`pgcrypto` (auto-created), advisory locks for boot/races. Socket.IO is
single-process (documented limitation — no Redis adapter by decision;
first deployment is single-replica).
