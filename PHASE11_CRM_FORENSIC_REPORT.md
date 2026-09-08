# PHASE 11 — CRM Forensic Report

Method: full reads of `routes/pipelines.js` (512), contacts sections of
`routes/messages.js`, `middleware/access.js`, both delegated inventories
(frontend screens, schema), all verified by spot reads.

## Headline

CRM exists as THREE disconnected layers: (1) a complete but **tenant-blind**
pipeline/deal system, (2) a mature assignment-gated contact system with no
org awareness, (3) strict-org Tier-2 tables (`lead_notes/calls/follow_ups`)
with **no read APIs and no UI**. There is no lead-detail view, no activity
timeline API, no lead-status concept, and no event wiring between CRM writes
and the Phase 10 bus.

## Inventory + classification

| # | Component | State | Verdict |
|---|---|---|---|
| 1 | Pipelines/stages/deals CRUD + kanban + drag-drop | Complete, zero org hits, role-gated | **ADAPT** (org-scope every route; keep shapes) |
| 2 | Deal assignment + contact mirror (`syncContactAssignment`) | Works, no membership check, unscoped contact write | **ADAPT** (membership gate + org guard) |
| 3 | Contacts CRUD (save/import/change-number/delete) | Mature, assignment-gated, no org guards, no pagination on lists | **ADAPT** (org guards + pagination) |
| 4 | `assertContactAccess`/`assertWaAccess` (assignment model) | Correct for single-tenant; no org dimension | **KEEP** (+ org layer above, not replacing) |
| 5 | `lead_notes` (writes: AI + automation) | Strict-org, no read API, no UI | **ADAPT** (CRUD + timeline union) |
| 6 | `lead_calls` | Table only, zero code hits | **REBUILD** (minimal CRUD) |
| 7 | `follow_ups` + 60s sweeper | Writes + sweeper work; no update/complete/cancel API, no UI | **ADAPT** (lifecycle API) |
| 8 | ContactsPage (list/search/tags/import/broadcast/detail modal) | Real APIs, no mocks, no pagination | **ADAPT** (lead detail extension, filters, pagination) |
| 9 | PipelinesPage (kanban, drag-drop, DealModal, KPIs) | Real APIs, optimistic move + revert | **KEEP** (works on scoped APIs unchanged) |
| 10 | Lead-detail view / timeline UI | Does not exist | **REBUILD** (inside contact detail, not a new page) |
| 11 | FollowUpSequencePage | Stump placeholder | **REMOVE** from scope (leave stub; follow-ups live in lead detail) |
| 12 | Lead status / stage-at-lead-level | Does not exist (deals: open/won/lost; qualifications: 4-state) | **REBUILD** (contact-level status + stage link, additive migration) |
| 13 | Activity store | Does not exist | **REBUILD** (`lead_activities` for operator actions; unions for the rest) |
| 14 | CRM → automation events | None (writes bypass the bus) | **REBUILD** (emit on status/stage/assign/note/call/followup paths) |
| 15 | CRM realtime events | None | **REBUILD** (7 org-scoped events via Phase 7 emitter) |
| 16 | Broadcasts/import/change-number | Working, out of CRM-operating scope | **DEFER** (untouched except org guards where trivial) |
| 17 | Forecasting/telephone/enterprise search/ads attribution | — | **REMOVE** from scope (explicitly excluded) |

## Key evidence

- pipelines.js: 0 hits for `organization_id|req.org|membership`; global
  `GET /pipelines` (no WHERE); dangling `assignedUserId` accepted; stage-type
  changes don't cascade deal status; `PUT /stages/:id` touches row on empty
  body; `PUT` pipeline shape lacks stages.
- contacts key `(wa_number, contact_number)` global UNIQUE (065 keeps it);
  org column nullable/backfilled; writes never filter org; lists unpaginated.
- `contacts.save`: sales may only edit owned; tags overwrite; blank-name
  preserve; assignment force-self for sales.
- `lead_notes` readers: none. `lead_calls` all-usage: none. `follow_ups`
  lifecycle beyond insert+sweep: none.
- No `LeadDetail`, no timeline API, no `lead_status` column anywhere.

## Secret/env posture

No CRM secrets exist (no new credentials). Unchanged. Historical scrub
remains separate.
