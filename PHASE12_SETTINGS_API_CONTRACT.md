# PHASE12 — Settings API Contract (`/api/v1/settings/*`)

Dual-mounted under `/api` (legacy compat) and `/api/v1` (canonical) like all
protected routers. Auth: cookie session (`authMiddleware`) → `resolveTenant`.
Org context is **always** `req.org.id` (membership-derived); a forged
`X-Org-Id` fails closed at the tenant layer (403) before any handler runs.
Errors are `{ error, code? }` with HTTP status; 500s are masked.

Related: invitations live under `/api/v1/orgs/:id/invitations/*` and
`/api/v1/invitations/:token/*` (see implementation report § invitations).

## Auth (extended)

| Method | Path | Access | Body | Success | Errors |
|---|---|---|---|---|---|
| POST | `/auth/register` | public | `{ email, password≥8, displayName?, organizationName? }` | 201 `{ user(session), organization{id,name,slug} }` — sets session cookie | 400 invalid, 409 `email-taken` |
| POST | `/auth/login` | public | `{ email, password }` | 200 `{ user }` | 401, 403 disabled |
| GET | `/auth/me` | auth | — | 200 `{ user }` (fresh `pages` incl. grants) | 401 |
| POST | `/auth/logout` | auth | — | 200 `{ ok:true }` (client also drops socket/org hint) | — |

## Organization settings

| Method | Path | Access | Body | Success | Errors |
|---|---|---|---|---|---|
| GET | `/v1/settings/organization` | any member | — | 200 `{ id,name,slug,plan,timezone,locale,businessName,onboardingCompletedAt,role }` | 403 no-org, 404 |
| PUT | `/v1/settings/organization` | org owner/admin | `{ name?, timezone?, locale?, businessName? }` — timezone IANA/`UTC`, locale `xx`/`xx-XX` | 200 updated org | 400 empty/no-op, 403 member, 422 bad timezone/locale |

## Onboarding (server-persisted)

Steps: `organization → whatsapp → team → ai → automation → complete`.
`organization` is the only required step; completion additionally requires
CRM defaults (≥1 pipeline). Step status is **derived from real backend
counts** on every read — client hints (`seen`/`dismissed`) never complete it.

| Method | Path | Access | Body | Success | Errors |
|---|---|---|---|---|---|
| GET | `/v1/settings/onboarding` | any member | — | 200 `{ stored, completedAt, derived{steps,completed,crmReady}, completed }` | 403 |
| PATCH | `/v1/settings/onboarding` | any member | `{ step, seen?, dismissed? }` (`complete` rejected) | 200 updated view | 400 unknown step |
| POST | `/v1/settings/onboarding/complete` | org owner/admin | — | 200 `{ completed:true, … }` | 403 member, 409 `onboarding-incomplete` + derived |

## Profile (user-owned, never org-scoped)

| Method | Path | Access | Body | Success | Errors |
|---|---|---|---|---|---|
| GET | `/v1/settings/profile` | auth (self) | — | 200 `{ id,username,email,displayName,role,isActive,lastLoginAt,createdAt }` | 401/404 |
| PUT | `/v1/settings/profile` | auth (self) | `{ displayName }` (email/role are admin-managed) | 200 updated | 400 empty |
| POST | `/v1/settings/password` | auth (self) | `{ currentPassword, newPassword≥8 }` | 200 `{ ok:true }` | 400, 401 wrong current, 422 short |

## WhatsApp status (real backend state)

| Method | Path | Access | Success |
|---|---|---|---|
| GET | `/v1/settings/whatsapp-status` | any member | 200 `{ status, accounts[], detail }` — `status ∈ not-configured｜incomplete｜verification-pending｜connected｜error`. Never `connected` from a frontend attempt. Account shapes carry health fields only — **no secrets**. |

## Overview hub (onboarding wizard, one call)

| Method | Path | Access | Success |
|---|---|---|---|
| GET | `/v1/settings/overview` | member (requires resolved org; multi-org callers without `X-Org-Id` get 403) | 200 `{ organization, onboarding, whatsapp{total,active}, team{size}, ai{entitled,granted,used,remaining}, automation{count}, crm{pipelines} }`. AI/billing sections are best-effort (defaults when billing tables predate) and always reflect entitlement data, never invented limits. |

## Organizations (extended) & invitations

| Method | Path | Access | Notes |
|---|---|---|---|
| POST | `/v1/orgs` | auth | Optional `Idempotency-Key` header: replays return the first response, no duplicate org. Creator merged with owner page grants. 409 slug conflict. |
| POST | `/v1/orgs/:id/invitations` | org owner/admin of `:id` | `{ email, role:admin｜member }` → 201 invite + one-time `token`. Re-issues revoke prior live rows. 409 `already-member`. |
| GET | `/v1/orgs/:id/invitations` | org owner/admin | List (never tokens). |
| POST | `/v1/orgs/:id/invitations/:inviteId/revoke` | org owner/admin | 404 when already used. |
| GET | `/v1/invitations/:token` | auth | Preview `{ organizationName,email,role,expiresAt }`. 404 unknown, 410 used/revoked/expired. |
| POST | `/v1/invitations/:token/accept` | auth (email must match invite) | Token sets org context; client orgId ignored. Idempotent membership insert; marks single-use; merges role page grants. 403 email mismatch, 410 invalid. |

## CRM bootstrap

| Method | Path | Access | Success | Errors |
|---|---|---|---|---|
| POST | `/pipelines/init-default` | instance admin **or** org owner/admin (`adminOrOrgManager`) | 201 `{ created:true, pipeline }` first time; 200 `{ created:false, pipelineId }` after (advisory-locked, race-safe) | 403 member |

## Status/code catalog (frontend `friendlyApiError` maps these; stacks never shown)

`no-organization · not-member · ambiguous-organization · onboarding-incomplete ·
already-member · email-taken · migration-required · quota-exceeded ·
subscription-expired · billing-forbidden` + HTTP 400/401/403/404/409/422/429/500.
401 routes to login; WhatsApp-disconnected surfaces billing/settings guidance.
