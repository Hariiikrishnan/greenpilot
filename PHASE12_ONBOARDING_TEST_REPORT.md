# PHASE12 — Onboarding Test Report

Environment: Windows, Node `node:test` (backend) + vitest (frontend),
migration-provisioned database for wire tests (71 migrations applied by the
runner, incl. new `070_onboarding_settings.sql`).

## Results

| Suite | Result |
|---|---|
| Backend `npm test` | **191/191 pass** (baseline 165 + 26 new) |
| Backend `npm run lint` | PASS |
| Backend `npm run typecheck` (`tsc --noEmit`) | PASS |
| Frontend `vitest run` | **95/95 pass** (baseline 86 + 9 new) |
| Frontend `vite build` (production) | PASS (pre-existing >500kB chunk warning only) |
| Migrations | 71/71 applied (`[migrate] up to date (71 migrations)`) |

## New coverage

**`backend/test/onboarding.test.js` (10 unit, stubbed db — no Postgres):**
onboarding step catalog/required set · state normalize (null/garbage) ·
step-update accept/reject (`complete` rejected, unknown rejected) ·
token randomness/hash determinism/raw-never-persisted/timing-safe compare ·
invite validation (owner rejected, bad email rejected) · derived status for
new org (only organization complete; `completed:false` without CRM defaults) ·
derived completion for ready org · per-org query scoping (ORG_B never leaks
ORG_A) · save/load round-trip scoping · token-binds-org contract.

**`backend/test/onboardingHttp.test.js` (12 wire, real app + DB):**
register→session+org / duplicate 409 · `Idempotency-Key` replay = same org,
one row · overview real state (org complete, whatsapp pending, incomplete) ·
init-default create→replay idempotent + 6 default stages + stranger org
untouched · complete 409 pre-init (`onboarding-incomplete`) → 200 post-init,
persisted · member read-OK/edit-403, timezone 422, profile rename, password
401-wrong/200-right + fresh login · invite create→lookup→accept→replay-410 +
membership visible · email-mismatch 403 + revoke→410 · cross-tenant forgery
403 on settings/invites/whatsapp-status · whatsapp-status
not-configured→connected (direct row), no secret leak, stranger isolated ·
multi-org caller without `X-Org-Id` fails closed (403, no silent pick).

**Extended existing files:** `access.test.js` (+2 `adminOrOrgManager`),
`permissions.test.js` (+2 grant-matrix/merge), `frontend/src/utils/apiError.test.js`
(9: 401/403/404/429/500-collapse/machine codes/WhatsApp passthrough/
prefix-strip/isAuthError).

## End-to-end new-customer chain (evidence composition, no fake states)

Register → org → onboarding (server state) → CRM init → complete →
invite/accept → settings guards → WhatsApp status: **proven live** by the
wire suite above. The remaining links reuse previously-verified green paths:
WhatsApp lead intake → AI qualification → CRM update → automation → realtime
fan-out (Phase 7/9/10/11 suites green, untouched), billing/usage visibility
(Phase 8 suite green). The Meta-credentialed live send path cannot run in CI
(no test credentials); WhatsApp setup вместо proves credential verification
+ real status derivation, and the UI never claims `connected` without it.

## Regression statement

Phases 6 (tenant), 7 (realtime), 8 (billing), 9 (AI), 10 (automation),
11 (CRM) suites all pass unmodified (191 total). `adminOnly` semantics
unchanged (existing test intact); `adminOrOrgManager` is additive and used
only by `POST/PUT/DELETE /whatsapp-accounts` and `POST /pipelines/init-default`.
No advertising code introduced anywhere (grep-verified scope of change).
