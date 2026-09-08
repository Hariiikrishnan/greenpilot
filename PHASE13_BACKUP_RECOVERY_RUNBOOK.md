# PHASE13 — Backup & Recovery Runbook

## Status: OPERATIONAL DEPENDENCY (outside the repository)

No backup automation ships in this repo (verified: no cron/snapshot config in
compose, Dockerfiles, workflows, or scripts). Backups are the operator's
duty. Do NOT claim backups exist until the steps below are executed on the
production host.

## What to back up (in priority order)

1. **Postgres `pgdata` volume** — authoritative for everything except media
   blobs on disk. Nightly `pg_dump -Fc` + weekly base backup minimum.
2. **`secrets` volume (`instance.json`)** — auto-generated JWT + WhatsApp
   encryption key. Loss = all stored WhatsApp tokens unreadable (reconnect
   every number). Back up with `chmod 600`, off-host.
3. **`media` + `uploads` volumes** — reconstructible-ish (Meta CDN ~30d;
   re-download), but treat as backup-worthy.
4. `backend/.env` (host file, gitignored) — required to boot.

## Suggested host procedure (reference — adapt to provider)

```sh
# nightly logical backup (keeps 14d locally + offsite copy)
docker compose exec -T forgecrm-db pg_dump -U postgres -Fc postgres \
  > /backups/greenpilot-$(date +%F).dump
# volumes (stop or use atomic driver snapshots for consistency)
docker compose stop forgecrm-backend
tar -czf /backups/volumes-$(date +%F).tgz \
  $(docker volume inspect --format '{{.Mountpoint}}' greenpilot_secrets) \
  $(docker volume inspect --format '{{.Mountpoint}}' greenpilot_media)
docker compose start forgecrm-backend
```

Managed Postgres (RDS/Cloud SQL/DigitalOcean): enable automated daily
snapshots + point-in-time recovery instead of the above.

## Restore procedure

1. Provision host, restore `.env` + `secrets` volume FIRST (keys before data).
2. Restore `pgdata` (or `pg_restore -d postgres backup.dump` into a fresh
   `postgres:15` container).
3. `docker compose up -d`; boot applies pending migrations automatically
   (ledger-guarded, multi-replica safe). Verify `/ready` → `{"ok":true}`.
4. Re-point Meta webhook URL if the domain changed; send a test message.

## Migration rollback strategy

- Migrations are additive + `IF NOT EXISTS`-guarded with a
  `schema_migrations` ledger; there is no down-migration runner.
- Rollback = restore pre-deploy DB backup, then deploy previous image tag.
- `065` FK validation raises (fail-closed) on dangling org refs — fix data,
  never `--force` past it.
- Emergency forward-fix preferred over rollback for additive migrations.

## Recovery testing (quarterly)

Restore the latest backup to a staging host, boot, check `/ready`, log in,
spot-check inbox/CRM/billing. Record date + result in ops notes.

## Reconstructible vs authoritative

Authoritative (loss = data loss): Postgres rows, `secrets` keys, uploaded
media. Reconstructible: WhatsApp display numbers (Meta re-lookup), message
ticks (status reconciler), derived dashboard aggregates, realtime state.
