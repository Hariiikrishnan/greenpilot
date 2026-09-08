# PHASE 5 — API Evolution Map (→ `/api/v1/*`)

> Phase 5 rule: do not break the working engine with a bulk rename. v1 aliases are
> mounted alongside legacy routes (same handlers, `Deprecation: true` + `Sunset`
> headers on legacy). Legacy removal only after frontend + Meta webhook configs
> migrate (see per-row plan).

## Conventions
- `KEEP` = stays as canonical path. `ADAPT` = same handler, tenant-aware + v1 alias.
  `REPLACE` = v1 route with new semantics planned. `REMOVE` = drop with version + reason.

## Route map (legacy → target)

| Legacy (`/api/*`) | Verdict | v1 target | Removal/compat plan |
|---|---|---|---|
| `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, `GET /auth/status`, `POST /auth/setup` | ADAPT | `/api/v1/auth/*` (alias live) | legacy sunset after frontend cutover (Phase 6) |
| `GET /numbers`, `/contacts`, `/messages`, `/contact`, `/saved-contacts`, contact CRUD/import | ADAPT | `/api/v1/chats`, `/api/v1/leads/*`, `/api/v1/leads/:id/messages` (leads surface staged; chats alias live) | legacy sunset with frontend cutover |
| `POST /messages/send`, `/send-media`, `/send-audio`, `/send-library-media`, `/mark-read`, `/react`, `/star` | ADAPT | `/api/v1/chats/*` (alias live) | same as above |
| `POST /webhook/whatsapp` (Meta, public+HMAC) | ADAPT | `POST /api/v1/webhooks/whatsapp/:orgId` (org-aware; NEW in Phase 5) + `GET` verify | legacy kept until Meta re-pointed; then REMOVE |
| `/users/*`, `/audit-log` (admin) | ADAPT | `/api/v1/settings/members/*` (staged) | sunset with settings revamp |
| `/orgs/*` (NEW) | KEEP | `/api/v1/orgs/*` canonical from birth | n/a (no legacy) |
| `/whatsapp-accounts/*`, `/by-phone/:phone` | ADAPT | `/api/v1/settings/whatsapp/*` (staged) | sunset with settings revamp |
| `/agents/*`, `/agent-conversation/*`, `/ai-models/*` | ADAPT | `/api/v1/ai/*` (staged) | sunset with AI surfaces |
| `/chatbots/*`, `/executions/*` | ADAPT | `/api/v1/automations/*` (staged) | sunset with automation revamp |
| `/templates/*` | ADAPT | `/api/v1/templates/*` (staged) | sunset with template revamp |
| `/broadcasts/*` | ADAPT | `/api/v1/broadcasts/*` (staged) | sunset |
| `/media-library/*`, `/media/:id`, `/upload` | ADAPT | `/api/v1/media/*` (staged) | sunset |
| `/pipelines/*`, `/deals/*` | ADAPT | `/api/v1/crm/*` (staged) | sunset with CRM revamp |
| `/categories`, `/tags`, `/contact-fields` | ADAPT | `/api/v1/settings/taxonomy/*` (staged) | sunset |
| `/google-integrations/*` (+public callback) | KEEP | unchanged path under v1 alias | keep (OAuth callback URL stability) |
| `/dashboard`, `/details` | ADAPT | `/api/v1/analytics/*` (staged) | sunset |
| `/events` (SSE) | KEEP (until Socket.IO) | superseded by Socket.IO rooms (staged) | remove with realtime cutover |
| `/mcp/*`, `/mcp/http/:key` | KEEP | unchanged (connector URL stability) | keep |

## v1 alias mechanics (implemented)
- `index.js` mounts every protected router twice: `/api` (legacy) and `/api/v1`
  (canonical-in-progress). Public webhook/MCP/auth keep exact behavior.
- Middleware `v1Compat` sets `req.apiVersion='v1'|'legacy'` and, on legacy paths
  only, `Deprecation: true` + `Sunset: <Phase 6 date TBD>`.
- New org endpoints exist ONLY under `/api/v1/orgs` (+ legacy mirror for auth-flow
  simplicity — single canonical: v1; see routes/organizations.js).
