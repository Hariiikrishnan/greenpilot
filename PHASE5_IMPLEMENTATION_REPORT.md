# PHASE 5 — Implementation Report (ForgeChat Evolution into Green Pilot)

> Date: 2026-09-04. Decisions recorded: commercial SaaS use **cleared**;
> **Option A** (evolve this tree) adopted. No parallel app, no wrapper.
> Verdict is at the bottom: **PHASE 5 STATUS: BLOCKED** (itemized; no hard-stop
> violation — blockers are unmet completion criteria + approval-gated migrations).

## 1. Current → target architecture
- Current (verified): single-owner Express 4 + raw-pg (`coexistence`, 59
  migrations) + BullMQ ×3 + SSE/polling + Vite/React 18 hash-router SPA. Cookie
  JWT, role RBAC, WA-assignment scoping. No billing, no ads, no Prisma/TS/Next.
- Target: Green Pilot SaaS (org multi-tenancy, `/api/v1`, per-org WhatsApp,
  quota-aware AI, Socket.IO, billing) — full definition in
  `PHASE5_GREENPILOT_TARGET_ARCHITECTURE.md`. Evolution by adaptation, not rewrite.

## 2. Module classification (detail: `PHASE5_FORGECHAT_TO_GREENPILOT_EVOLUTION_MAP.md`)
- KEEP: payload normalization, outbound engine + send queue, media pipeline,
  templates/broadcasts/media-library, dashboard, Google Sheets/OAuth, infra/CI.
- ADAPT: webhook (org-aware v1 — implemented), agent/AI engine + CRM tools
  (scoping specified; ledger staged), automation (node catalogue staged),
  contacts/pipelines (lead convergence staged), auth (+membership — implemented),
  MCP (per-org gates staged), frontend shell (org context — implemented),
  users/teams (membership convergence staged).
- REBUILD: qualification (no source exists — staged), billing/quotas (greenfield;
  org ledger fields shipped in 059).
- REMOVE: `FollowUpSequencePage` placeholder, fake delete-`alert()` (removed),
  `FMOS` footer pending legal verify; `PlaceholderPage` kept until real surfaces land.
- DEFER: TypeScript/Prisma, Next.js, Zustand, Socket.IO cutover, condition/delay
  nodes, bulk route rename, cookie/queue renames (flag-day plans documented).

## 3. Database changes (executed vs proposed)
- EXECUTED (additive, verified live on embedded Postgres 000→060 chain):
  `059_organizations.sql` (organizations + organization_members + indexes),
  `060_whatsapp_account_org.sql` (nullable `organization_id` + index). No rows
  touched; rollback one-liners in-file. Note: validation ran against the local
  dev database only; production rollout follows the normal boot-runner path.
- PROPOSED, approval-gated (see `PHASE5_DATABASE_EVOLUTION_PLAN.md`): personal-org
  seeding, per-table `organization_id` backfills, `conversations`, `leads`
  convergence, `ai_usage_ledger`, UNIQUE enforcement. NOT executed per the
  non-destructive rule.

## 4. Tenancy implementation (Step 5)
- `backend/src/tenancy/organizations.js`: membership-only context resolution,
  owner-atomic org creation, webhook org-match rule (all pool-injectable).
- `backend/src/middleware/tenant.js`: `resolveTenant` (X-Org-Id honored only with
  membership; multi-org ambiguity fails closed; pre-tenancy DBs degrade safely)
  + `requireOrg`.
- `backend/src/routes/organizations.js`: list/create/members/add/remove with
  owner-last-owner protection. Canonical `/api/v1/orgs`.
- Tests `backend/test/tenant.test.js`: 9 cases (A↔B forge/deny, implicit/ambiguous
  context, webhook match matrix, slug safety). **Backend suite 29/29 pass.**

## 5. WhatsApp ownership (Step 6)
- Global singleton cap replaced with per-org ownership: multiple numbers per org
  allowed; legacy installs keep the exact old guard. List/get/update/delete all
  enforce `(NULL OR mine)` dual-read scoping with 404 (no leak) semantics.
- Webhook: new canonical `POST /api/v1/webhooks/whatsapp/:orgId` (+ org-scoped
  GET verify) enforcing account→org match pre-processing; legacy Meta callback
  unchanged until re-pointed. `getAccountOrgByPhoneNumberId` exported for reuse.

## 6. API evolution (Step 7)
- `PHASE5_API_EVOLUTION_MAP.md` written (KEEP/ADAPT/REPLACE/REMOVE per route,
  Sunset plan). Implemented: all protected routers dual-mounted `/api` (legacy +
  `Deprecation`/`Sunset: Sun, 01 Aug 2027` provisional) and `/api/v1`
  (`req.apiVersion` marker); auth aliased under v1; webhook/MCP paths stable.

## 7. Frontend evolution (Step 8)
- Org context shipped: `X-Org-Id` injection, `api.orgs` client, Topbar workspace
  switcher (multi-org dropdown, persisted, reload-safe), real role label.
- Legacy `forgecrm.*` storage keys migrated with carry-over; remaining Forge
  code comments renamed; fake account-delete control replaced with an honest
  support notice (no fake success). No mock APIs added; optimistic UI + previews
  unchanged. **Frontend unit 51/51 pass; `vite build` passes.**

## 8. AI / automation / realtime / billing (Steps 9–12)
- Shipped: org model with quota fields, tenant middleware covering AI/automation
  routes, org-scoped WA config + webhook gate, per-org account model for agent
  routing. Staged (documented with migration approach): `(org, contact)`
  serialization + credit pre-check + idempotency ledger, CRM tool extension
  (status/note/assign/follow-up), `QualificationService` build, automation node
  catalogue + org job context, Socket.IO rooms `org-{id}`, billing provider.

## 9. Security findings (Step 13 baseline)
- PASS: no secrets in tracked files (rescan incl. new files); `.env.example`
  placeholders only; `.env` ignored/untracked; HMAC + verify-token logic
  preserved and extended org-aware; explicit CORS unchanged (no wildcard);
  authenticated zone intact (login verified unaffected — public mounts precede
  the zone); tenant tests green; queue/AI tenant enforcement staged behind
  approval-gated columns (no bypass introduced).
- INCIDENT: `LICENSE.md` was found staged-deleted mid-session (not by any Phase 5
  edit — cause undetermined, possibly external). Restored byte-identical via
  `git checkout HEAD`; `TRADEMARK.md`/`AUTHORS.md` verified intact. No license
  text was modified at any point. Recommend enabling branch protection/audit for
  legal files. Refresh-token + password-reset strategies documented (staged).

## 10. Tests / builds (Step 14)
- Backend `npm test`: **29/29 pass** (20 existing + 9 tenant). Frontend
  `test:unit`: **51/51 pass**. Frontend `vite build`: **PASS** (chunk-size
  advisory only). Migrations 000→060 applied cleanly on embedded Postgres.
- TypeScript `tsc --noEmit`: N/A (no TS toolchain in repo). `npm run lint`: N/A
  (no lint config). Neither suppressed nor faked — recorded as criteria gaps.

## 11. Hard-stop audit (§HARD STOPS, 12 items)
1. Licensing insufficient — NO (cleared per decisions; notices preserved + restored).
2. Data destroyed — NO (additive migrations only; dev-DB validation, no prod touch).
3. Isolation unguaranteeable — NO at implemented layer (tested); deeper tables
   staged, single-owner behavior preserved, no cross-tenant path introduced.
4. Global singleton necessary — NO (per-org model shipped).
5–6. Auth/billing weakened — NO (auth chain extended, not replaced; no billing existed).
7–8. AI/queue cross-org — NO (gates shipped where schema allows; rest staged, none bypassed).
9. Advertising imported — NO (zero ads code; reverified).
10. License notices removed — NO (restored; intact at close).
11. Destructive migration without approval — NO (none executed beyond additive).
12. Undocumented rewrite — NO (rewrite-class items have staged plans).

## 12. Blockers (why NOT complete)
- B1: per-table org backfills + `conversations`/`leads`/`ai_usage_ledger`
  require explicit approval (non-destructive rule) — tenancy below the account
  layer is staged, not enforced.
- B2: TypeScript + lint toolchains do not exist; completion criteria demand
  passes that cannot be produced without adding them (doing so unasked would
  expand scope and risk the engine).
- B3: Socket.IO, billing provider, per-org webhook-secret enforcement, and
  `QualificationService` are architected but unbuilt (each needs B1).

## 13. Technical debt carried forward
Cookie/queue renames (flag days), legacy route sunset (prov. Aug 2027), Next.js /
Zustand evaluations, `FMOS` footer legal verify, `PlaceholderPage` removal,
historical secret-scrub/rotation (prior report item, still open, not claimed).

## 14. Confirmations
- Advertising functionality remains **excluded** — none in source, none added,
  none referenced (search-verified this session).
- Required license notices remain **intact** — `LICENSE.md` (restored
  byte-identical), `TRADEMARK.md`, `AUTHORS.md` unmodified; internal attribution
  preserved.

---
**PHASE 5 STATUS: BLOCKED** — blocked by B1 (approval-gated data migrations),
B2 (TS/lint tooling passes), B3 (staged builds). No hard-stop violation remains;
foundation implemented, verified, and non-destructive.
