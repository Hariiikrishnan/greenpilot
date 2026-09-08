# Green Pilot — Phase 15: Production VPS + Docker Deployment Report

## 1. Deployment Overview

| Metric / Parameter | Production Value |
|:---|:---|
| **Canonical Repository** | `git@github.com:sriramavinash3/green-pilot.git` |
| **Branch** | `main` |
| **Phase 14 Validated Baseline Commit** | `fb2b75d787f518bb6c53a65e3557619468000225` |
| **Production Release Commit (Deployed)** | `25fe9c4` (`4da291e` on local) |
| **Target Production VPS** | `187.127.173.247` (Ubuntu 22.04.5 LTS Jammy) |
| **Deployment Directory** | `/opt/greenpilot/` |
| **Repository Path on VPS** | `/opt/greenpilot/app/` |
| **Deployment Timestamp** | `2026-09-05T04:15:00Z` (`09:45 IST`) |

---

## 2. Docker & Container Status

* **Docker Engine Version**: `Docker version 29.6.1, build 8900f1d`
* **Docker Compose Version**: `Docker Compose version v5.3.1`

### Running Production Containers

| Service Name | Container Name | Image | Status | Published Ports (Host) | Health Status |
|:---|:---|:---|:---|:---|:---|
| **api** | `greenpilot-backend` | `greenpilot-backend:latest` | Up (healthy) | `127.0.0.1:5050->3011/tcp` | **HEALTHY** (`/ready` probe) |
| **web** | `greenpilot-frontend` | `greenpilot-frontend:latest`| Up | `127.0.0.1:8082->80/tcp` | **UP** (200 OK) |
| **postgres** | `greenpilot-postgres` | `postgres:16-alpine` | Up (healthy) | *None (Private Docker network)* | **HEALTHY** (`pg_isready`) |
| **redis** | `greenpilot-redis` | `redis:7.2-alpine` | Up (healthy) | *None (Private Docker network)* | **HEALTHY** (`redis-cli ping`) |
| **worker** | *Internal to API* | `greenpilot-backend:latest` | Running inside API container | *N/A (BullMQ consumers active)* | **HEALTHY** (media, send, agent, automation) |
| **caddy** | `greenpilot-caddy` | `caddy:2` | Profile: `caddy` (Standby) | Standby profile in compose | **STANDBY** (Host Nginx active) |

> [!NOTE]
> **Reverse Proxy Architecture Note**: As documented in Step 16 of the mission contract, the VPS hosts pre-existing live production domains (`onerepute.com`, `revenuepilot.in`, `freddiebusiness.com`) managed by host Nginx. Green Pilot routes incoming traffic through host Nginx with WebSocket upgrade support, while internal ports `5050` and `8082` bind strictly to loopback (`127.0.0.1`). Database (`5432`) and Redis (`6379`) have zero host port exposure.

---

## 3. Domains & Public Routing

| Public Domain | Route Target | Target Internal Port | SSL / TLS Status |
|:---|:---|:---|:---|
| `https://api.greenpilot.in` | Green Pilot Backend API | `http://127.0.0.1:5050` | **ACTIVE** (Let's Encrypt, Valid) |
| `https://greenpilot.in` | Green Pilot Frontend (SPA) | `http://127.0.0.1:8082` | **ACTIVE** (Let's Encrypt, Valid) |
| `https://app.greenpilot.in` | Green Pilot Frontend (SPA) | `http://127.0.0.1:8082` | **CONFIGURED** (Awaiting Registrar A-Record) |

---

## 4. DNS Status

| DNS Record | Record Type | Configured Target | Resolved IP | Status |
|:---|:---|:---|:---|:---|
| `api.greenpilot.in` | `A` | `187.127.173.247` | `187.127.173.247` | **PASS** |
| `greenpilot.in` | `A` | `187.127.173.247` | `187.127.173.247` | **PASS** |
| `app.greenpilot.in` | `A` | `187.127.173.247` | *Not yet published in DNS* | **PENDING DNS A-RECORD** |

---

## 5. HTTPS & SSL/TLS Verification

* **Certificate Authority**: Let's Encrypt (`/etc/letsencrypt/live/api.greenpilot.in/` & `/etc/letsencrypt/live/greenpilot.in/`)
* **HTTPS Enforcement**: HTTP Port 80 automatically redirects with `301 Moved Permanently` to `https://$host$request_uri`.
* **Security Headers**:
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN`
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Content-Security-Policy: default-src 'none'`
* **WebSocket Upgrade**: Verified via `https://api.greenpilot.in/socket.io/?EIO=4&transport=polling` (handshake sid returned with `upgrades: ["websocket"]`).

---

## 6. Database Verification

* **PostgreSQL Engine**: `PostgreSQL 16.14 on x86_64-pc-linux-musl (Alpine 16-alpine)`
* **Migration Ledger Table**: `coexistence.schema_migrations`
* **Applied Migrations Count**: **71 / 71 applied** (0 pending)
* **Persistent Named Volume**: `greenpilot_postgres_data` (`/var/lib/postgresql/data`)
* **Persistence Test**: Service restarted; row counts in `coexistence.organizations` verified identical pre- and post-restart.
* **Database Backup (`pg_dump`)**:
  - Filename: `/opt/greenpilot/backups/greenpilot_20260905_041432.dump`
  - File Size: `193 KB` (Custom compressed `-Fc` format)
* **Restore Validation (`pg_restore`)**:
  - Restored into temporary database `greenpilot_restore_test` without error.
  - Verified 71 migrations and 10 organization records intact.
  - Temporary database cleanly dropped.

---

## 7. Redis Cache & Broker Verification

* **Redis Engine**: `Redis 7.2.16 (Alpine)`
* **Persistence**: Named volume `greenpilot_redis_data` mounted to `/data`
* **Reconnection Resilience**: Redis restarted; BullMQ queues reconnected and `/ready` probe recovered to `ready: true, checks: { redis: true }` within 1.2 seconds.

---

## 8. Security Controls & Boundary Validation

| Security Control | Validation Method | Result |
|:---|:---|:---|
| **CORS Restriction** | `CORS_ORIGIN=https://app.greenpilot.in`, `CORS_ORIGINS=https://app.greenpilot.in,https://greenpilot.in` | **ENFORCED** |
| **HttpOnly Session Cookies** | Inspected `Set-Cookie` header on login/register (`HttpOnly; SameSite=Strict; Secure`) | **ENFORCED** |
| **Unauthenticated Route Defense** | `GET /api/v1/leads` without session cookie | **REJECTED (401 Unauthorized)** |
| **Role-Based Access Control (RBAC)**| Member role attempts `PUT /api/v1/settings/organization` | **REJECTED (403 Forbidden)** |
| **Multi-Tenant Isolation** | Tenant B user queries Tenant A lead ID | **DENIED (403 not-member / 404)** |
| **WhatsApp HMAC Signature** | Forged signature `sha256=0000...` dispatched to webhook | **REJECTED (403 Forbidden)** |
| **Valid WhatsApp HMAC Signature** | Real HMAC-SHA256 signature calculated with `META_APP_SECRET` | **ACCEPTED (200 OK, stored=1)** |
| **Firewall (UFW)** | Active; incoming default deny; only `22`, `80`, `443` open | **ENFORCED** |
| **Internal Port Exposure** | `5432` (Postgres) and `6379` (Redis) have no host binding | **ZERO EXPOSURE** |
| **Secret Hygiene** | Inspected container logs; verified `.env.production` mode 600 outside git | **ZERO SECRETS IN LOGS OR GIT** |

---

## 9. Real Customer Smoke Test Verification (Production VPS)

Executed against `https://api.greenpilot.in`:

```text
=== GREEN PILOT PHASE 14/15 PRODUCTION RUNNER TRACE ===
[1/10] Infrastructure Health & Readiness: PASS (/health: 76ms, /ready: 19.6ms)
[2/10] Account Lifecycle (Register/Login/Logout/Password Change): PASS
[3/10] Workspace Creation & Organization Settings (GreenFlow Renewables): PASS
[4/10] Team Invitations & RBAC Verification (Priya Nair, Member): PASS (403 on Org Settings)
[5/10] WhatsApp Inbound Webhook (Rohan Sharma, 919811600451): PASS (Processed in 12.89ms)
[6/10] CRM Operations (Pipeline stage, note, call, follow-up, timeline): PASS (Timeline in 14.2ms)
[7/10] Outbound Messaging & Delivery Receipts (sent -> delivered -> read): PASS
[8/10] AI Qualification Engine (Score: 94/100, ledger debited 570 tokens): PASS
[9/10] Automation Engine (Trigger: lead.created, status='success'): PASS
[10/10] Billing Catalog & Security Checks (4 plans returned, trial active): PASS
```

---

## 10. Automated Test Suite Metrics

* **Frontend Unit Tests (Vitest)**: **95 / 95 PASS**
* **Frontend Production Build**: **PASS** (`vite build` compiled in 1.12s)
* **Backend Linting (ESLint)**: **0 Errors**
* **Backend Typecheck (tsc)**: **0 Errors**
* **Production Integration Suite (`phase14_validation_runner.js`)**: **100% PASS (Zero Defects)**

---

## 11. Resource Utilization

* **Memory Usage**:
  - `greenpilot-backend`: 97.95 MiB (2.50%)
  - `greenpilot-frontend`: 2.54 MiB (0.06%)
  - `greenpilot-postgres`: 43.28 MiB (1.11%)
  - `greenpilot-redis`: 3.15 MiB (0.08%)
  - **Total Stack Memory**: ~147 MiB
* **System Available Memory**: 2.3 GiB free
* **System Disk Available**: 31 GiB (37% used)
* **Database Size**: 11 MB

---

## 12. Files Created & Modified

### On Production VPS (`187.127.173.247`):
- `/opt/greenpilot/docker-compose.prod.yml`
- `/opt/greenpilot/Caddyfile`
- `/opt/greenpilot/.env.production` (permissions 600, outside git)
- `/opt/greenpilot/backups/greenpilot_20260905_041432.dump`
- `/etc/nginx/sites-available/api.greenpilot.in` (updated reverse proxy)
- `/etc/nginx/sites-available/master-router` (updated reverse proxy)
- `/opt/greenpilot/app/` (Git repository at commit `25fe9c4`)

### In Local Repository:
- `docker-compose.prod.yml`
- `.env.production.example`
- `frontend/nginx.conf` (added socket.io location block)
- `backend/package.json` (optionalDependencies for linux compatibility)
- `backend/Dockerfile` (package*.json copy)
- `backend/src/routes/webhook.js` (removed unused import for lint cleanliness)
- `PHASE15_PRODUCTION_DEPLOYMENT_REPORT.md`

---

## 13. Known Open Action Items

1. **DNS A-Record for `app.greenpilot.in`**:
   - `api.greenpilot.in` and `greenpilot.in` are live and resolving to `187.127.173.247`.
   - Please add the DNS `A` record for `app.greenpilot.in` pointing to `187.127.173.247`.
   - Once DNS propagates, run `certbot --nginx -d app.greenpilot.in` on the VPS to attach an SSL certificate to `app.greenpilot.in`. In the interim, `https://greenpilot.in` provides immediate HTTPS access to the identical frontend.
2. **GitHub Deploy Key**:
   - The public ed25519 key generated on the VPS is:
     `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxtgxaioiMxq4o+EuGV7RU6zbiZUzCJ2U8WEkcFdkEE greenpilot-vps`
   - Add this key to `GitHub -> sriramavinash3/green-pilot -> Settings -> Deploy keys` to permit future git fetches.

---

## 14. Disaster Recovery & Rollback Procedures

### Application Rollback
To roll back to a previous commit:
```bash
cd /opt/greenpilot/app
git checkout <previous_commit_hash>
docker compose -f /opt/greenpilot/docker-compose.prod.yml build api web
docker compose -f /opt/greenpilot/docker-compose.prod.yml up -d api web
```

### Database Restore Procedure
To restore from the Phase 15 production backup:
```bash
docker compose -f /opt/greenpilot/docker-compose.prod.yml exec -T postgres pg_restore \
  -U postgres -d postgres --clean --if-exists /opt/greenpilot/backups/greenpilot_20260905_041432.dump
```
