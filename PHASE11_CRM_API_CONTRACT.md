# PHASE 11 — CRM API Contract

Auth: session cookie. Org: `req.org` (membership-derived; forgery → 403
upstream). Invisible leads/pipelines/deals/executions read as 404 (no
probing). Errors: `{ error, code? }`, never foreign-org data. Roles: existing
model — global `admin` bypasses assignment gates; `adminOnly` guards
pipeline/stage/deal management; sales work assigned records; billing stays
separate (Phase 8).

## Leads — `/api/v1/leads/*` (new, canonical)

- `GET /leads?search&status&stageId&assignedUserId&qualification&page&limit`
  → `{ data: [lead…], total, page, totalPages }` (limit ≤100). `status=new`
  matches NULL-or-new; `assignedUserId=unassigned` matches NULL;
  `qualification=` filters by latest qualification status. Lead rows carry
  `qualification {status,score,…}` + `openFollowups`.
- `GET /leads/by-contact?waNumber&contactNumber` → enriched lead or 404
  (inbox bridge; digits normalized server-side).
- `GET /leads/:id` → lead + `qualification` + `openFollowups` + linked
  `deals[]` (org, same pair) + `conversation` (latest org thread) or 404.
- `POST /leads { waNumber*, contactNumber*, name?, assignedUserId? }` →
  201 (stamped, `lead-created` socket + `lead.created` bus event); duplicate
  pair → 409 `{ error, leadId }`.
- `DELETE /leads/:id` → `{ ok:true }` (CRM row only; history retained).
- `PATCH /leads/:id/status { status* }` → `{ …lead, changed, previous }`.
  Enum: new/contacted/qualified/unqualified/needs-more-information/won/lost.
  Row-locked; unchanged values are no-ops; writes activity; socket
  `lead-status-changed`; bus `lead.status.changed`
  (`leadstatus:{org}:{wa}:{contact}:{status}` — repeat sets idempotent).
- `PATCH /leads/:id/stage { stageId|null }` → `{ …lead, changed }`.
  Stage + pipeline must belong to the org (404 otherwise). Writes activity;
  socket `lead-updated`; bus `lead.status.changed`
  (`leadstage:{org}:{wa}:{contact}:{stage}`).
- `PATCH /leads/:id/assign { userId|null }` → `{ …lead, changed }`.
  Assignee must be an active org member (400 otherwise). Writes activity;
  socket `lead-assigned`.

## CRM — `/api/v1/crm/*` (new, canonical)

- `GET /crm/notes?contactNumber` → notes (≤50, newest first).
  `POST /crm/notes { waNumber*, contactNumber*, body* }` → 201 (+
  `activity-created` socket). `PUT /crm/notes/:id { body }`,
  `DELETE /crm/notes/:id` (org-scoped, 404 otherwise).
- `GET /crm/calls?contactNumber`, `POST /crm/calls { …, outcome?, notes? }`,
  `DELETE /crm/calls/:id` (same scoping; no telephony — manual log only).
- `GET /crm/followups?contactNumber&status&page` → `{ data, total, page,
  totalPages }`. `POST /crm/followups { …, dueAt*, assignedTo? }` → 201
  (future datetime required; assignee membership-checked; `followup-created`
  socket). `POST /crm/followups/:id/complete|cancel` (pending-only, else
  404; `followup-completed` socket). Due rows still converge via the Phase 10
  60s sweeper (no second scheduler).
- `GET /crm/activity?waNumber&contactNumber&limit` → merged timeline
  (operator activities + notes + calls + follow-ups + qualifications +
  WhatsApp excerpts + automation runs), newest-first, ≤50. Summaries only.

## Pipelines / deals (evolved in place, same paths + shapes)

- `GET /pipelines` (org dual-read, stages nested — PUT shape fixed to match),
  `POST /pipelines { name }` (stamps org + default stages),
  `PUT /pipelines/:id`, `DELETE /pipelines/:id` (per-org last-pipeline guard).
- `POST /pipelines/:id/stages`, `PUT /stages/:id` (empty-name/stageType now
  400; type changes recompute deal statuses), `DELETE /stages/:id`.
- `GET /deals?pipelineId` + `/deals/metrics` (404 on invisible pipeline;
  org + assignment scoped), `POST /deals` (pipeline/stage/contact/assignee
  all org-validated), `PUT /deals/:id`, `POST /deals/:id/move`
  (row-locked, same-stage no-op, bus `lead.status.changed`
  `dealstage:{deal}:{stage}` + `lead-status-changed` socket),
  `DELETE /deals/:id`, `GET /deals/contact-search` (org-scoped).

## Contacts (hardened in place, shapes preserved)

- `GET /contacts`, `GET /saved-contacts`: org-scoped + server cap 500
  (array shape kept for the inbox UI).
- `POST /contacts/save`: org pre-check (403 on foreign rows), org stamp on
  create, admin assignment membership-checked.
- `POST /contacts/change-number`: source scoped + all 7 migrated tables
  org-scoped (incl. `lead_activities`).
- `DELETE /contact`, `GET /contact`, `GET /contact-names`: org-scoped.

## Realtime (all `org:{id}` rooms, ids + hints)

`lead-created`, `lead-updated`, `lead-assigned`, `lead-status-changed`,
`followup-created`, `followup-completed`, `activity-created` (Phase 7
emitter allowlist; frontend refreshes on receipt).

## Worker-internal (not HTTP)

- `transitionLead` (row-locked status/stage/assign with activity + emits).
- `sweepDueFollowups` unchanged (Phase 10) — follow-up lifecycle now
  manageable end-to-end via the API above.
