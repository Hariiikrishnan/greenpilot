# PHASE 5 — ForgeChat → Green Pilot Evolution Map

> Date: 2026-09-04. Strategy: **Option A — evolve this tree** (commercial SaaS use
> cleared; license/copyright notices preserved untouched).
> Basis: full-tree forensic inventory (Phase 5 Step 1). Every subsystem gets exactly
> one verdict: KEEP / ADAPT / REBUILD / REMOVE / DEFER.
> Product boundary: WhatsApp CRM + AI lead qualification + team inbox + CRM pipeline
> + automation. **No advertising functionality exists in-tree and none is introduced.**

## Subsystem verdicts

### 1. WhatsApp webhook ingestion + HMAC verification — ADAPT
- Location: `backend/src/routes/webhook.js` (GET challenge :523, POST :267),
  `backend/src/util/webhookSignature.js`, raw-body capture `index.js:92`.
- Responsibility: Meta verification handshake, HMAC-SHA256 auth, payload parse,
  persistence, trigger fan-out.
- Dependencies: `pg` pool, `util/crypto.js`, automation engine, agent router,
  media queue, SSE bus.
- Target: `POST /api/v1/webhooks/whatsapp/:orgId` resolving org from WhatsApp
  configuration; per-org app secret enforced (no warn-only mode).
- Migration: add org-resolution step (`resolveOrgForAccount` by `phone_number_id`);
  keep parse/persist logic byte-identical.
- Tenant implications: all downstream writes stamped with resolved org; cross-org
  webhook delivery impossible by construction.
- API implications: new canonical v1 webhook route; legacy `/api/webhook/whatsapp`
  kept as compat until Meta configs are re-pointed (removal plan in API map).
- DB implications: `whatsapp_accounts.organization_id` (nullable-first, staged
  backfill — approval-gated).
- Risk: medium (auth-adjacent). Recommended: implement org resolution + v1 route
  in Phase 5; enforce per-org secret in Phase 6.

### 2. Payload normalization (`parseMetaPayload`) — KEEP
- Location: `routes/webhook.js:34-190`. All Meta message/status/echo types, phone
  normalization, reaction attachment, monotonic `STATUS_RANK`.
- Target: unchanged logic, later extracted to `services/whatsapp/normalize.js`
  during the TypeScript migration. No tenant/API/DB impact.

### 3. Outbound engine (`metaSend.js` + `messageSender.js` + `forgecrm-send` queue) — KEEP
- Location: `integrations/metaSend.js`, `services/messageSender.js`,
  `queue/sendQueue.js` (concurrency 5, attempts 4, 60/s under Meta Tier-1 ceiling).
- Production-worthy; optimistic-row → enqueue → wamid-swap flow is exactly the
  Green Pilot §10 pattern. Keep; add `organizationId` to job data in Phase 6.

### 4. Media pipeline — KEEP
- `queue/mediaQueue.js`, `services/mediaDownloader.js`, `integrations/metaMedia.js`,
  `metaResumableUpload.js`, `util/pgStorage.js`, `services/transcription.js`.
- Keep; org-scope storage paths during per-org media rollout (staged).

### 5. Agent queue + AI engine + router — ADAPT
- `queue/agentQueue.js`, `engine/agentEngine.js`, `services/agentRouter.js`,
  `services/agentService.js`, `llm/` (OpenAI/Anthropic), builder routes
  (`agents.js`, `agentConversation.js`, `aiModels.js`).
- Valuable (tool loop, gates, precedence chain, run telemetry). Must become
  org-scoped, lead/conversation-scoped, quota-aware with idempotent ledger.
- Tenant implications: `(org, contact)` serialization; pre-execution credit check;
  tools call org-scoped service layer. DB: `agent_runs` + new `ai_usage_ledger`
  gain `organization_id`.

### 6. CRM tools (`agentCrmTools.js`) — ADAPT
- Contact-scoped executors are the right pattern; extend to update-status /
  add-note / assign / follow-up against Green Pilot lead services with
  `(organization_id, entity_id)` checks. Never raw model-supplied IDs.

### 7. Qualification — REBUILD (nothing to keep; no source exists)
- No qualification module exists. Build `QualificationService` new per the
  §12 flow with anti-fabrication (`null` when unconfident). DEFER full build to
  Phase 6; Phase 5 establishes org/lead/ledger prerequisites.

### 8. Automation engine — ADAPT
- `engine/automationEngine.js`, `routes/chatbots.js`, `AutomationBuilderView.jsx`.
- Keep runner, logging, pause/resume + sweepers. Re-enable condition/delay/action
  node handlers (currently parked) behind the Green Pilot trigger/action
  catalogue (lead created, inbound message, lead qualified, status changed,
  follow-up due → send/assign/note/follow-up/invoke-AI). Jobs carry org context.

### 9. Contacts/CRM + pipelines/deals — ADAPT
- `routes/messages.js` (contacts), `routes/pipelines.js`, `PipelinesPage.jsx`,
  `ContactsPage.jsx`. Solid CRUD/kanban; need `organization_id` ownership +
  lead-model convergence (contacts ↔ leads merge plan in DB evolution doc).

### 10. Auth (cookie JWT + RBAC + WA scoping) — ADAPT
- `auth.js`, `permissions.js`, `middleware/access.js`. Keep cookie-JWT + per-request
  role check; ADD organization membership layer (`organizations`,
  `organization_members`, `resolveTenant` middleware). Roles converge to
  org-scoped `owner/admin/member`; legacy `bda_sales/viewer` mapped, not dropped
  (data-preserving).

### 11. Realtime (SSE `events.js` + polling) — DEFER (target: REPLACE with Socket.IO)
- Works today; single-process bus. Green Pilot canonical is Socket.IO rooms
  `org-{id}`. Replacement is staged (needs multi-replica story + frontend store
  migration); SSE stays canonical for Phase 5. No wildcard CORS exists to remove
  (explicit `CORS_ORIGIN` + localhost allowlist verified).

### 12. Templates / broadcasts / media library — KEEP (org-scope staged)
- `routes/templates.js`, `broadcasts.js`, `mediaLibrary.js` + Meta integrations.
  Keep; add `organization_id` per DB plan; per-org template polling later.

### 13. MCP (`routes/mcp.js`, `mcpHttp.js`, `mcp-server/`) — ADAPT (selective)
- Keep discovery + agent CRUD under capability gates; re-scope per-org; never a
  tenant bypass. Rename `forgecrm_token`/docs references opportunistically.

### 14. Dashboard/analytics — KEEP (scope staged)
- `routes/dashboard.js`, `HomePage.jsx`. Keep; add org filter + billing/usage
  surfaces later.

### 15. Frontend shell (hash router, polling, api.js, pages) — ADAPT
- Already Green Pilot branded (zero ForgeChat brand strings; only `forgecrm.*`
  localStorage keys + code comments). Adapt: org context (switcher + `X-Org-Id`),
  rename storage keys (with migration), staged Zustand + Next.js evaluation —
  NOT a rewrite in Phase 5.

### 16. Users/teams/audit (`routes/users.js`, `middleware/access.js` audit) — ADAPT
- Converge into org memberships; keep audit log, extend with `organization_id`.

### 17. Google Sheets/OAuth integrations — KEEP
- `services/googleSheets.js`, `googleAuth.js`, `routes/googleIntegrations.js`.
  Sheets tools only; no ads adjacency. Org-scope credentials staged.

### 18. Infra (Docker, Caddy, CI, migrations runner) — KEEP
- Compose, prod overlay, CI (backend/frontend/migrations/secret-scan/gitleaks/
  license-check) all keep. Extend CI with tenant-isolation tests (done Phase 5).

### 19. Billing/quotas — REBUILD (greenfield; none exists)
- No billing code exists (only automation stub comments). Green Pilot billing
  (subscription state, org quotas, payment verification, secret hygiene) is a
  new build; Phase 5 adds the org-aware ledger foundation + documents the rest.

### 20. REMOVE
- `FollowUpSequencePage.jsx` placeholder route, `PlaceholderPage.jsx` "Coming
  Soon" (remove when real surfaces land; keep until then to avoid dead nav),
  `GeneralTab` fake delete-`alert()` (replace with real API or remove),
  Timezone-only-local control (persist or remove), `FMOS` powered-by footer if
  not a legal notice (verify; branding, not license text).

### 21. DEFER (useful, postponed with reason)
- TypeScript/Prisma migration (needs ORM decision + ado­mạin-by-domain port; keeps
  plain-JS engine stable meanwhile).
- Next.js migration (Vite SPA works; hash-router → App Router is a rewrite-class
  change needing its own plan).
- Zustand `useChatStore` (needs Socket.IO + API v1 first).
- `QualificationService` full build (needs leads + ledger — prerequisites staged now).
- Condition/delay automation nodes re-enable (needs org-scoped jobs first).
- `GET /api/v1/*` full route rename (aliases ship now; bulk rename deferred to
  avoid breaking the working engine).
