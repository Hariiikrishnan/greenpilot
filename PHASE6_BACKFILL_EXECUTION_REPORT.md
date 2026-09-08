# PHASE 6 — Backfill Execution Report (B1)

> Live-DB survey date: 2026-09-04/05 (embedded Postgres dev DB). Migrations
> 061–065 applied via the production boot runner (`runMigrations`, ledgered,
> fail-closed). Rollback statements live in-file per migration.

## Survey method
Row counts + owner-linkage probes per table before writing any migration
(`inspect` scripts, since removed). Results below are the BEFORE state.

## Per-table record

| Table | Before | After | Existing owner link | Backfill source / rule | Ambiguous | Orphan | NULL left | Handling |
|---|---|---|---|---|---|---|---|---|
| `forgecrm_users` (1) | 1 | 1 | self (identity root) | n/a (seed anchor) | 0 | 0 | n/a | seed 1 org + owner membership (061) |
| `organizations` | 0 | 1 | — | per-user workspace (`workspace-user-<id>`) | 0 | 0 | n/a | deterministic from user identity |
| `organization_members` | 0 | 1 | user | owner row for user 1 | 0 | 0 | n/a | same |
| `whatsapp_accounts` | 0 | 0 | none yet | Rule A: `user_wa_assignments` number → single user → org | 0 | 0 | 0 | no-op (no rows); rule live for populated DBs |
| `contacts` | 0 | 0 | `wa_number` | Rule F: business number → account org | 0 | 0 | 0 | no-op; validator live |
| `chat_history` | 0 | 0 | `wa_number`/`phone_number_id` | Rule F | 0 | 0 | 0 | no-op; validator live |
| `conversations` (new) | — | 0 | — | Rule K from history | 0 | 0 | n/a | empty; backfilled on traffic |
| `agents` | 1 | 1 (NULL org) | `wa_account_id` NULL | Rule B (needs account link) | 0 | 0 | **1 manual** | draft agent, no account — left NULL, NOT guessed |
| `agent_runs` | 0 | 0 | agent | inherits run's agent (app-layer, staged) | 0 | 0 | 0 | column ready |
| `chatbots` | 0 | 0 | none (config only) | none defensible | 0 | 0 | 0 | manual-mapping class when rows exist |
| `automation_executions` | 0 | 0 | `wa_number` | Rule I → account org | 0 | 0 | 0 | no-op |
| `message_templates` | 0 | 0 | `whatsapp_account_id` | Rule G | 0 | 0 | 0 | no-op; validator live |
| `media_library` | 0 | 0 | `whatsapp_account_id` | Rule G | 0 | 0 | 0 | no-op; validator live |
| `broadcasts` | 0 | 0 | `from_number` | Rule H → account org | 0 | 0 | 0 | no-op |
| `broadcast_logs` | 0 | 0 | `broadcast_id` | Rule H (parent inherit) | 0 | 0 | 0 | no-op |
| `pipelines` | 1 | 1 (NULL org) | `created_by` NULL | Rule C (needs creator) | 0 | 0 | **1 manual** | default pipeline, no creator — left NULL |
| `pipeline_stages` | 6 | 6 (NULL org) | `pipeline_id` | Rule C2 (parent inherit — parent NULL → stays NULL) | 0 | 0 | **6 manual** | follows parent; inherits org when pipeline mapped |
| `deals` | 0 | 0 | `assigned_user_id`/`created_by` | Rules D/D2 | 0 | 0 | 0 | no-op |
| `tags` (4) / `categories` (2) | 6 | 6 (no org col) | none (shared taxonomy) | none — deliberate exception | 0 | 0 | n/a | global reference until per-org duplication ships |
| `contact_field_definitions` (0) | 0 | 0 | none | none — same exception class | 0 | 0 | 0 | column ready, unassigned |
| `ai_models` (0) | 0 | 0 | none (global fallback) | none — deliberate exception | 0 | 0 | 0 | no org column (global reference) |
| `oauth_credentials` (0) | 0 | 0 | `user_id` | Rule E | 0 | 0 | 0 | no-op |
| `google_oauth_credentials` (0) | 0 | 0 | app-level | none — exception (app client) | 0 | 0 | 0 | no org column |
| `mcp_api_keys` (0)/`mcp_settings` (1) | 1 | 1 | deployment-level | none — exception | 0 | 0 | n/a | no org columns |
| `webhook_events` (0) | 0 | 0 | `phone_number_id` | Rule J (immutable trail) | 0 | 0 | 0 | no-op |
| `conversation_reads`/`message_reactions` (0) | 0 | 0 | parent thread | staged (follow contacts) | 0 | 0 | 0 | columns ready |
| `wa_links` (0) | 0 | 0 | unclear semantics | none — manual class | 0 | 0 | 0 | column ready |
| `user_audit_log` (0) | 0 | 0 | actor | immutable trail — exception | 0 | 0 | 0 | column ready, unassigned |
| `ai_usage_ledger`/`lead_notes`/`lead_calls`/`follow_ups`/`billing_subscriptions` (new) | — | 0 | — | start empty, NOT NULL org | 0 | 0 | n/a | greenfield with enforced ownership |
| `team_members`/`broadcast_variable_mapping` | — | — | frozen legacy | none | — | — | n/a | untouched (non-destructive rule) |

## Step 2 compliance (never guess)
- Silently assigned rows: **0**. Every NULL remainder above is classified
  manual-mapping with its reason; validators in 064 raise EXCEPTION if a row a
  rule SHOULD catch escapes it.
- The single-org shortcut was explicitly NOT used: pipeline/agent NULLs were left
  in place despite exactly one org existing.
- Deterministic rules reference existing relationships only (assignment table,
  account links, user links, parent inheritance).

## Reconciliation (Step 16 — before → after)
| Check | Before | After | Delta explanation |
|---|---|---|---|
| users | 1 | 1 | unchanged |
| organizations | 0 | 1 | seeded (061) |
| memberships | 0 | 1 | seeded (061) |
| agents / pipelines / stages / tags / cats / mcp_settings | 1/1/6/4/2/1 | identical | untouched (columns added, rows unmodified) |
| all operational tables | 0 | 0 | no traffic during migration |
| FK integrity | n/a | 29 org FKs, validated, zero dangling | 065 validator passed |
| orphan rows created | — | 0 | additive only |
| unexplained loss | — | **none** | every delta accounted above |
