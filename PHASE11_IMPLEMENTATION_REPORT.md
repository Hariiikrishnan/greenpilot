# PHASE 11 — Implementation Report (CRM Pipeline, Deals, Assignment & Follow-Up)

## 1. Forensic findings

`PHASE11_CRM_FORENSIC_REPORT.md`: complete-but-tenant-blind pipelines/deals,
assignment-gated but org-blind contacts, strict-org Tier-2 tables with no
read APIs or UI, no lead-detail view, no timeline API, no lead status, no
CRM→automation wiring. Classified KEEP/ADAPT/REBUILD/REMOVE/DEFER.

## 2. Lead model

Lead ≡ contact (composite `(wa_number, contact_number)`, org-owned). No
parallel table — every subsystem already keys on the pair. Enrichment:
`lead_status` (default `new`, canonical enum), optional `pipeline_stage_id`
(FK SET NULL), assignment, qualification (latest), open follow-ups, linked
deals, latest conversation thread. Migration 069 additive only.

## 3. Pipeline / stages

Org-scoped CRUD (dual-read, adoption-on-write, per-org last-pipeline guard);
stages stamped with pipeline org; `PUT` shape fixed to include stages;
`stage_type` changes recompute derived deal statuses; empty-name/invalid-type
now 400 (were silent). Deterministic `position` ordering kept; server remains
move authority (drag-drop validated per move).

## 4. Deals

Org integrity on pipeline, stage, contact, and assignee (membership-checked);
derived `open/won/lost` + `won_at/lost_at` kept; row-locked moves converge;
same-stage moves are no-ops; moves feed the automation bus (deterministic
`dealstage:{deal}:{stage}` id) + `lead-status-changed` socket.

## 5. Assignment

Contact + deal assignment require active org membership (API, automation
Assign action (Phase 10), AI handoff (Phase 9), contacts/save). Foreign and
ghost users rejected. Round-robin: existing agent-handoff mechanism reused
where it exists; lead assignment is manual + automation-driven (sufficient
per scope — no new auto-assign invented).

## 6. Status / stage operations

Row-locked transitions: validate tenant → update → activity → socket +
automation bus. Repeat values are no-ops (idempotent downstream). Status
enum: new/contacted/qualified/unqualified/needs-more-information/won/lost.

## 7. Notes / calls / follow-ups

Real persisted CRUD (org-scoped, author-stamped); follow-ups validate future
`dueAt` + member assignees, with complete/cancel transitions and the
unchanged Phase 10 due sweeper (no second scheduler).

## 8. Activity / timeline

`lead_activities` persists operator actions (created/status/stage/assigned);
timeline unions activities + notes + calls + follow-ups + qualifications +
WhatsApp excerpts + automation runs — newest-first, bounded (≤50),
summaries only, no chain-of-thought.

## 9. WhatsApp integration

Lead detail resolves the org thread; `by-contact` bridges inbox context to
lead ids; no duplicate lead records (409 + leadId); number migration carries
activities along org-scoped.

## 10. AI integration

Qualification (status/score/summary/time) surfaced in lead view, list
enrichment, filters, and timeline. No reasoning exposed, no AI records
duplicated.

## 11. Automation integration

Existing bus reused (no second system): `lead.created` (API + webhook,
shared deterministic id), `lead.qualified` (Phase 9), `lead.status.changed`
(status/stage/deal operations), `followup.due` (sweeper). Loop protection
verified terminating (visited/depth).

## 12. Socket.IO integration

Seven org-room events (`lead-created/updated/assigned/status-changed`,
`followup-created/completed`, `activity-created`), ids + hints only.
Inbox detail, contacts list, and pipeline board refresh on receipt. A-only
delivery test-proven. No SSE introduced.

## 13. API contract

`PHASE11_CRM_API_CONTRACT.md`: new `/v1/leads/*` + `/v1/crm/*`; pipelines/
deals evolved in place (shapes preserved); contacts hardened (org guards,
500-caps, legacy array shapes kept).

## 14. Frontend changes

`LeadDetail.jsx` (new: qualification/stage/assign/timeline/notes/calls/
follow-ups) embedded in the contact detail modal (view mode); pipeline
board live-refreshes on CRM events; `api.leads.*` + `api.crm.*` added.
No visual-language redesign; no new pages.

## 15. Pagination / search

Leads/follow-ups: real `{data,total,page,totalPages}` (limits clamped);
legacy inbox lists: server cap 500, shapes unchanged. Filters (search/
status/stage/assignee/qualification) tenant-contained (test-proven).

## 16. Concurrency

Row locks on status/stage/assign/deal-move; concurrent moves converge to one
stage (test-proven); idempotent repeat operations.

## 17. Tenant isolation

Every read/write scoped (strict); cross-org access reads 404; forged org
403s at the middleware; membership-gated assignment; integrity tests across
leads/pipelines/stages/deals/notes/calls/follow-ups/activity/timeline.

## 18. Tests — backend 165/165, frontend 86/86 (detail: `PHASE11_CRM_TEST_REPORT.md`)

## 19. Builds

`tsc` ✅ · `eslint` ✅ · `vite build` ✅ · migrations 70/70 ✅.

## 20. Remaining limitations

- `contact_ref`-keyed notes/calls/follow-ups are contact-number-scoped (two
  business numbers sharing a customer number share those lists within an
  org — pre-existing key design, documented).
- Legacy NULL-org rows stay readable to org callers in list paths (dual-read
  transition); writes are strict.
- FollowUpSequencePage stub untouched; forecasting/telephony/enterprise
  search excluded per scope.

---

**PHASE 11 STATUS: COMPLETE**
