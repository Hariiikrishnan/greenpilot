# PHASE12 — Onboarding Forensic Report

Scope: registration, login, org creation/selection, onboarding, profile, team,
WhatsApp config, AI/automation/CRM defaults, notifications, security, billing
nav, settings pages, route guards, mocks, hardcoded defaults, storage
assumptions. Inspected `backend/src/**`, `frontend/src/**`, `db/migrations/*`.

Verdict scale: KEEP · ADAPT · REBUILD · REMOVE · DEFER.

## 1. Auth / registration / login

| Area | Finding | Verdict |
|---|---|---|
| `POST /auth/login`, cookie `forgecrm_token` (httpOnly, 24h), per-request role + `is_active` re-check | Sound session foundation | KEEP |
| `GET /auth/me`, `POST /auth/logout`, `GET /auth/status` | Real, wired to LoginGate/SetupWizard | KEEP |
| First-run `POST /auth/setup` (advisory-locked, 409 after first user) | Correct single-boot strap | KEEP |
| **No self-signup** — only setup-wizard + admin-created users | SaaS blocker | REBUILD → `POST /auth/register` (user + personal org + owner membership, atomic; 409 on taken email) DONE |
| No self password-change endpoint | Gap | REBUILD → `POST /v1/settings/password` DONE |
| Cookie/table names `forgecrm_*`, fallback secret string | Internal compat, not user-visible | DEFER (rename is breaking; no user impact) |

## 2. Organizations / onboarding state

| Area | Finding | Verdict |
|---|---|---|
| `tenancy/organizations.js`: membership-only context, forged id → 403, multi-org → 400 ambiguous, no-org → 403 | Correct fail-closed core | KEEP |
| `POST /v1/orgs` had **no idempotency** — refresh/retry duplicated orgs | SaaS blocker | REBUILD → `Idempotency-Key` ledger (`idempotency_keys`), replay returns first response DONE |
| **No onboarding persistence** (only `setupRequired` boolean) | Spec hard-stop (#8) | REBUILD → `organizations.onboarding_state JSONB` + `onboarding_completed_at`, server-derived status DONE |
| `resolveTenant` + `requireOrg` middleware | Correct | KEEP |
| No org profile columns (timezone/locale/business) | Gap | REBUILD → migration 070 columns + settings API DONE |

## 3. Team / invitations / roles

| Area | Finding | Verdict |
|---|---|---|
| `GET/POST/DELETE /orgs/:id/members`: owner/admin add (admin|member only, no owner grant), owner-only remove, last-owner protected | Sound | KEEP |
| `users.js` admin CRUD + self-demote/delete guards + auditLog | Sound instance-admin surface | KEEP |
| **No invitation tokens** — add-member required a pre-existing user | SaaS blocker | REBUILD → `organization_invitations` (sha256 token hash, 7-day expiry, single-use, revocable, email-bound; token — never client orgId — sets context) DONE |
| Role model: org `owner/admin/member` + app `admin/bda_sales/viewer` + per-user page grants. Pre-existing, documented | Use as-is | KEEP (matrix documented in implementation report) |
| Gap found: org owners with `viewer` app role could not reach setup (WhatsApp connect, CRM init, settings tabs) — full SaaS blocker | Fix within existing models | ADAPT → `adminOrOrgManager` gate (precedent: billing `requireBillingManager`) + additive page grants on register/org-create/invite-accept DONE |

## 4. Settings / profile / security

| Area | Finding | Verdict |
|---|---|---|
| **No `/api/v1/settings/*`** — GeneralTab timezone was `useState`-only (mock persistence) | Spec hard-stop territory | REBUILD → settings router (organization/onboarding/profile/password/whatsapp-status/overview) DONE; GeneralTab now persists timezone via API DONE |
| Profile vs organization ownership mixed nowhere (no profile API at all) | Gap | REBUILD → distinct profile routes DONE |
| No security tab (password change, status) | Gap | REBUILD → ProfileTab security section DONE |
| `mcp/settings`, `googleIntegrations/credentials` (secret-masked) | Real, scoped | KEEP |
| Fake-delete control already removed (explicit comment) | Good | KEEP |

## 5. WhatsApp / AI / automation / CRM onboarding

| Area | Finding | Verdict |
|---|---|---|
| WhatsApp CRUD org-scoped (404 cross-org), secrets AES-256-GCM + masked, Meta credential check on save | Sound | KEEP; gate widened to org managers (setup necessity) |
| Health (`healthy/invalid_token/rate_limited/unknown`) in list payload + 60s Topbar poll | Real state, no dedicated endpoint | ADAPT → `GET /v1/settings/whatsapp-status` deriving not-configured/incomplete/verification-pending/connected/error DONE |
| AI `/v1/ai/status` (entitlement/usage/providers, no secret leak) | Sound | KEEP; surfaced in overview + wizard |
| Automations `/v1/automations/*` org-scoped + permission-gated | Sound | KEEP; wizard discovers, never forces creation |
| Pipelines `DEFAULT_STAGES` seeded on `POST /pipelines` (adminOnly) — new orgs had **no usable CRM** | Gap | REBUILD → `POST /pipelines/init-default` (advisory-locked, idempotent, org-manager allowed), auto-called by wizard + PipelinesPage DONE |
| Empty states (inbox/chats/contacts/pipelines/automation/billing) | Honest already ("No … yet" + guidance) | KEEP (minor: PipelinesPage now self-bootstraps) |

## 6. Frontend routes / guards / session

| Area | Finding | Verdict |
|---|---|---|
| Hash router + `user.pages` guard + admin-settings tab filter | Sound pattern | KEEP; extended with org-manager allowance (nav only — backend enforces) DONE |
| **No register/onboarding/invite-accept routes** | SaaS blocker | REBUILD → LoginGate register mode, server-gated OnboardingWizard, `#/invite/<token>` page DONE |
| Logout: cookie + `disconnectRealtime()` | Good | ADAPT → also clears active-org hint + org-role cache DONE |
| Org switch: full reload (implicitly fresh socket) | Safe | ADAPT → explicit `disconnectRealtime()` before reload DONE |
| `localStorage`: only `greenpilot.activeOrg` hint + UI widths — never config source of truth | Acceptable | KEEP |
| `req()` threw `"status body"` raw strings; no 401→login routing, no quota/subscription messaging | Gap | REBUILD → structured `{status, code}` errors + `friendlyApiError` mapper DONE |
| No `setTimeout` fake APIs, no hardcoded success, no mock users (only `vi.mock` in tests) | Clean | KEEP |
| ForgeChat strings: `forgecrm_*` cookie/tables, `create-forgechat-agent` MCP prompt, `forgechat.*` import-compat types, `forgechat-agent` queue name — all compat/internal, none user-visible | — | DEFER (rename breaks compat; documented) |

## 7. Notifications

No notification-settings surface exists (no notification pipeline in product).
Inventing one would be fake functionality → DEFER, documented as limitation.
