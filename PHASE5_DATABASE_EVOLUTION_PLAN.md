# PHASE 5 — Database Evolution Plan (ForgeChat → Green Pilot)

> Design only, except the explicitly listed **executed additive** migrations
> (`059`, `060` — new tables / nullable columns, no data touched).
> Rule: no migration may silently orphan data. Anything touching PKs, tenant
> ownership backfill, WhatsApp accounts, conversations/messages, or automation
> state needs explicit approval + rollback (flagged APPROVAL-GATED below).

## Conventions
- All objects live in schema `coexistence` (unchanged). Runner: `db/migrations/*.sql`
  via `backend/src/db/migrate.js` (ledgered, fail-closed).
- `organization_id UUID NULL REFERENCES organizations(id)` = stage-1 pattern:
  nullable add → code dual-reads (NULL = legacy single-owner scope) → backfill
  (APPROVAL-GATED) → `SET NOT NULL` → enforce.

## Model-by-model map

| ForgeChat model | Green Pilot model | Retain? | Org FK? | Keys/indexes | Data migrate? | Status |
|---|---|---|---|---|---|---|
| (none) | `organizations` | — new | — | `slug UNIQUE`; PK UUID | seed personal org per user (APPROVAL-GATED Executed: tables only) | **EXECUTED 059** (tables, no seed) |
| (none) | `organization_members` | — new | FK CASCADE | `UNIQUE(org, user)`; `INDEX(user_id)` | seed owner rows (APPROVAL-GATED) | **EXECUTED 059** (table, no seed) |
| `forgecrm_users` | users (same table) | retain | via members | keep PK; add `INDEX(email)` if missing (staged) | none | staged |
| `user_wa_assignments` | team assignment → org membership scope | merge (staged) | add (staged) | keep until members+conversations cover it | migrate to member scopes (APPROVAL-GATED) | staged |
| `contacts` | leads (converged; table kept, renamed conceptually) | retain | stage-1 | `UNIQUE(org, normalized_phone)` (staged) | backfill org from account (APPROVAL-GATED) | staged |
| `chat_history` | messages (same table) | retain | stage-1 | `INDEX(org, contact, ts)` (staged); keep `message_id` dedupe | backfill org via account (APPROVAL-GATED) | staged |
| (none) | `conversations` (inbox + `ai_enabled`) | — new | FK | `UNIQUE(org, account, contact)` | derive from history (APPROVAL-GATED) | staged |
| (none) | notes / calls / follow-ups | — new | FK | per-org indexes | none (greenfield) | staged |
| `whatsapp_accounts` | org WhatsApp configs (same table) | retain | **EXECUTED 060** nullable | `UNIQUE(org, phone_number_id)` (staged, post-backfill) | assign to personal orgs (APPROVAL-GATED) | stage-1 live |
| `message_templates` + revisions/analytics | same | retain | staged | per-org index | inherit account org (APPROVAL-GATED) | staged |
| `broadcasts`/`broadcast_logs` | same | retain | staged | per-org index | inherit (APPROVAL-GATED) | staged |
| `media_library` (+`whatsapp_account_id`) | same | retain | staged | per-org index | inherit account org (APPROVAL-GATED) | staged |
| `chatbots` | automations (same table) | retain | staged | per-org index | owner org (APPROVAL-GATED) | staged |
| `automation_executions`/`_steps` | same | retain | staged | `INDEX(org, status)` | inherit graph org (APPROVAL-GATED) | staged |
| `agents`/`agent_tools`/`agent_runs`/`_steps` | same | retain | staged | per-org index | owner org (APPROVAL-GATED) | staged |
| `ai_models` | same registry | retain | staged (global fallbacks stay global) | — | none | staged |
| (none) | `ai_usage_ledger` (idempotency + quota) | — new | FK | `UNIQUE(org, inbound_message_id)` | none (starts empty) | staged |
| `pipelines`/`stages`/`deals` | same | retain | staged | per-org index; validate assignee in-org | owner org (APPROVAL-GATED) | staged |
| `categories`/`tags`/`contact_field_definitions` | same taxonomy | retain | staged | per-org index | owner org (APPROVAL-GATED) | staged |
| `oauth_credentials`/`google_oauth_credentials` | same | retain | staged | per-org index | owner org (APPROVAL-GATED) | staged |
| `mcp_api_keys`/`mcp_settings` | same | retain | staged | per-org capability gates | owner org (APPROVAL-GATED) | staged |
| `webhook_events` | same audit | retain | staged | `INDEX(org, kind)` | resolve via account (APPROVAL-GATED) | staged |
| `conversation_reads`, `message_reactions`, `wa_links`, `media_objects`, `user_audit_log` | same | retain | staged w/ parent | follow parent org | inherit (APPROVAL-GATED) | staged |
| `team_members`, `broadcast_variable_mapping` | legacy leftovers | retain (no drop) | — | — | none (non-destructive rule) | frozen |

## Rollback / preservation guarantees
- Executed migrations are purely additive: 059 creates two tables; 060 adds one
  nullable column + index. Rollback = `DROP TABLE organization_members,
  organizations` / `ALTER TABLE whatsapp_accounts DROP COLUMN organization_id`
  (documented in-file); no user data affected either way.
- Singleton guard (`041`) stays until per-org accounts + backfill ship; removing
  it early would permit unowned accounts.
- Boot runner aborts on any migration failure — operator sees the file, no
  half-migrated serving state.
