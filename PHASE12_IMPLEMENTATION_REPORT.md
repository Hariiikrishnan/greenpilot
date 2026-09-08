# PHASE12 — Implementation Report (SaaS Onboarding, Org Settings & Production UX)

First-login lifecycle now: `Register → org established → authenticated →
server onboarding state → wizard-or-dashboard`. Full contract:
`PHASE12_SETTINGS_API_CONTRACT.md`; forensics: `PHASE12_ONBOARDING_FORENSIC_REPORT.md`;
evidence: `PHASE12_ONBOARDING_TEST_REPORT.md`.

## Onboarding architecture

Server-driven wizard (`frontend/src/components/OnboardingWizard.jsx`) fed by
`GET /v1/settings/overview`; step status derived from real backend counts
(`backend/src/onboarding/service.js::computeOnboardingStatus`); UI hints
(`seen`/`dismissed`) stored in `organizations.onboarding_state` (migration
`070_onboarding_settings.sql`) and never treated as completion. `POST
/v1/settings/onboarding/complete` (owner/admin) succeeds only when required
setup is real (org + CRM defaults), else 409 `onboarding-incomplete`. App
gates on the server value (`App.jsx`): fresh signups land in the wizard,
completed orgs go to dashboard, overview failures fail open to dashboard
(pre-migration backends never lock users out), "Skip for now" hides for the
session only.

## Organization initialization

`POST /auth/register` creates user + personal org + owner membership in one
transaction (advisory lock per email, 409 `email-taken`, sets session cookie,
returns fresh session incl. page grants). `POST /v1/orgs` accepts
`Idempotency-Key` (persisted ledger, replays return first response — no
duplicate orgs on refresh/retry). New owners receive additive page grants.

## Team management

`TeamTab.jsx` (Settings → Team): member list, invite, revoke, owner-only
remove — all org-scoped via active-org `X-Org-Id`, server re-checks
membership. Cross-org membership edits return 403/404 (wire-proven).

## Invitations

`backend/src/routes/invitations.js`: 256-bit token, sha256-persisted, 7-day
TTL, single-use (`accepted_at`), revocable, email-bound (accept requires
matching signed-in email), one live invite per (org,email). The **token sets
the org context** — client orgId is never read. Raw token returned once;
`#/invite/<token>` page previews then accepts and reloads the session.

## Roles

Existing models reused, no new system: org `owner/admin/member`
(membership-gated writes) + app `admin/bda_sales/viewer` + additive
`permissions.grant`. Matrix: owners — team pages + setup tabs
(organization/team/profile/whatsapp-accounts/billing/general); members —
team pages + general; instance-admin surfaces (users/mcp/integrations)
remain app-admin gated. New `adminOrOrgManager` middleware (precedent:
billing `requireBillingManager`) opens only WhatsApp connect/update/delete
and CRM bootstrap to org managers; `adminOnly` semantics untouched.

## WhatsApp onboarding

Status endpoint derives `not-configured|incomplete|verification-pending|
connected|error` from real rows/health; wizard, Organization tab, and Topbar
banner all read backend state; secrets never leave the API (wire-asserted).
Setup path: org → account → phone number → webhook verify → ready; Meta
credential check on save; cross-org attach impossible (per-query org scope).

## AI onboarding

Wizard + overview surface entitlement/usage from Phase 8 subscription/quota
data (`entitled/granted/used/remaining`) and qualifying-agent counts; plan
limits never invented (`pricingFinalized:false` preserved). No secrets/prompts
exposed (Phase 9 posture unchanged).

## Automation onboarding

Wizard discovers automation count and deep-links to the builder; creation
during onboarding is never required. No shared definitions — all rows
org-owned (Phase 10 isolation green).

## CRM defaults

`POST /pipelines/init-default`: advisory-locked, idempotent, strictly
org-scoped; creates `Sales Pipeline` + 6 standard stages only when the org
has none. Called by the wizard and `PipelinesPage` on load; safe to retry
and to call concurrently.

## Settings / profile / security

Settings router (`backend/src/routes/settings.js`): org GET (members) /
PUT (managers, validated timezone/locale); onboarding GET/PATCH/complete;
profile GET/PUT + password change (self only, current-password verified);
whatsapp-status; overview hub. New tabs Organization/Team/Profile with
loading/error/success states; GeneralTab timezone now persists via API
(read-only for members). Profile is user-owned and visually separated from
org settings. Security: password change, account status, sign-out; no
unsupported features added (no 2FA/sessions UI — honestly absent, not faked).

## Route protection

Unauthenticated → login (cookie gate, 401 + `isAuthError` routing);
wrong-org → 403 (tenant layer, wire-proven for settings/invites/whatsapp);
role → per-endpoint gates + nav filtering (App guard, `user.pages` +
org-manager allowance, tab filter). Covers dashboard/inbox/leads/CRM/
analytics/automation/settings/billing/onboarding. Multi-org without
selection fails closed (403, no silent pick — wire-proven).

## Organization switching / session cleanup

Switch: `disconnectRealtime()` → set hint → hard reload (CRM/inbox/
automation/AI/billing/realtime revalidate under new membership; server
re-authorizes every reconnect). Logout: logout API + socket disconnect +
active-org hint clear + org-role cache clear + state reset — no prior org
data visible afterwards on shared devices.

## Empty states / mock removal / error UX

Empty states were already honest (no fake records) and are kept; pipelines
self-bootstrap instead of stranding new orgs. No mock users/fake APIs/
`setTimeout` successes found; GeneralTab local-only timezone (the one
mock-persistence) fixed. `req()` errors are structured `{status,code}`;
`friendlyApiError` maps 401/403/404/409/422/429/500 + quota/subscription/
onboarding/invite codes to guidance without stack traces.

## Tests / builds

Backend 191/191, frontend 95/95, ESLint + `tsc --noEmit` pass, Vite
production build passes, 71/71 migrations apply. Phases 6–11 suites green.
No advertising functionality introduced; no engines redesigned; no pricing
or integrations invented; license notices untouched.

## Remaining limitations (documented, not invented)

1. Native-app page grants: instance admins still manage app roles/users
   globally; org owners get setup capability via grants, not global admin.
2. Automation creation still needs the `chatbot-builder` grant (discovery is
   open; creation is deliberately optional in onboarding).
3. No notification-settings surface (no notification pipeline exists).
4. Password change does not revoke other live JWT sessions (stateless 24h
   tokens; noted for a future session-revocation pass).
5. `forgecrm_*` internal names + `forgechat.*` import-compat aliases kept
   (breaking rename deferred; zero user-visible impact).
6. Live Meta-credentialed send path not exercisable in CI (no test
   credentials); covered by credential-check + status-derivation proofs.

**PHASE 12 STATUS: COMPLETE**
