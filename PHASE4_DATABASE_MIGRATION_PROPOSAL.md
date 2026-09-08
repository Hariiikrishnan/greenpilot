# PHASE 4 — Database Migration Proposal (NOT EXECUTED)

> Status: **PROPOSAL ONLY — NO MIGRATION HAS BEEN WRITTEN OR EXECUTED.**
> Per Phase 4 §17, this document must be reviewed and explicitly approved before
> any database change. No file under `db/migrations/` was added, modified, or run
> during Phase 4. `git status` is clean apart from the three Phase 4 `PHASE4_*.md`
> planning documents.

## 1. Current schema (what exists)

- Engine: raw SQL migrations `db/migrations/000_*.sql` → `058_*.sql` (59 files),
  applied at boot by `backend/src/db/migrate.js`, ledgered in
  `coexistence.schema_migrations`. Schema: `coexistence`. ORM: none (raw `pg`).
- Tenant model: **single-owner, single-WhatsApp-account** (see
  `SESSION-HANDOFF.md` + migration `041_whatsapp_accounts_singleton.sql`).
  There is **no `organizations` table, no `organizationId` column anywhere**,
  no Prisma schema, no `Conversation` / `Message` / `Lead` / quota models.
- Closest existing structures:
  - `coexistence.chat_history` — the message store (keyed by `message_id`,
    partitioned logically by `(wa_number, contact_number)`; dedupe via
    `ON CONFLICT (message_id)`; monotonic status guard in app code).
  - `coexistence.contacts` — the CRM record (keyed by `(wa_number, contact_number)`;
    `name` vs `profile_name` split; `tags` JSONB; `custom_fields` JSONB).
  - `coexistence.whatsapp_accounts` — WABA credentials (AES-256-GCM encrypted
    access token + verify token; `phone_number_id` stable key;
    `display_phone_number` auto-backfilled from webhooks).
  - `coexistence.webhook_events` — inbound audit trail consumed by
    `services/statusReconciler.js`.
  - `coexistence.agents` (+ `051/052/053/054/056/058` suite), `ai_models`,
    automation tables (`chatbots`, `automation_executions`,
    `automation_execution_steps`), `pipelines`, broadcasts, templates, media
    library, `message_reactions`, `conversation_reads`.

## 2. Verdict: the existing schema CANNOT support the Phase 4 engine as specified

Tenant isolation (§6) requires every WhatsApp/CRM/AI operation to be scoped by
`organizationId`. No table carries an organization owner, so multi-tenant
operation is impossible without additive schema work. Additionally the target
architecture names first-class `Organization`, `Conversation`, `Message`,
`WhatsAppAccount` (per-org), `Lead` (pipeline/stage/score/qualification fields),
and AI quota/usage models that do not exist.

## 3. Proposed change set (all ADDITIVE; no drops, no rewrites, no data deletion)

### 3.1 New `organizations` + membership
| Item | Detail |
| ---- | ------ |
| Model | `organizations(id UUID PK, name, slug UNIQUE, plan, ai_credit_balance, ai_credit_limit, created_at, updated_at)` |
| Model | `organization_members(id UUID PK, organization_id FK → organizations, user_id FK → forgecrm_users, role, created_at; UNIQUE(organization_id, user_id))` |
| Index | `organization_members(user_id)` for login→org resolution |
| Backfill | create one `organizations` row per existing `forgecrm_users` row ("personal workspace"); insert matching membership with role `owner` |
| Tenant implication | every row below hangs off this root; all access checks become `(organization_id, entity_id)` |
| Rollback | `DROP TABLE organization_members, organizations` (only if no child FKs remain) |

### 3.2 Tenant ownership columns on existing tables (nullable-first, then enforce)
| Table | Field | Index | Backfill | Rollback |
| ----- | ----- | ----- | -------- | -------- |
| `whatsapp_accounts` | `organization_id UUID NULL FK → organizations` | `UNIQUE(organization_id, phone_number_id)`; `INDEX(organization_id)` | map the single existing account to the owner's personal org | drop column/index |
| `contacts` | `organization_id UUID NULL FK` | `INDEX(organization_id, contact_number)`; keep existing `(wa_number, contact_number)` unique as legacy during transition | stamp from owning account's org via `display_phone_number` match; unmatched → owner's org with `needs_review=true` flag column | drop column/indexes |
| `chat_history` | `organization_id UUID NULL FK` | `INDEX(organization_id, contact_number, timestamp DESC)`; keep `message_id` PK/dedupe | stamp from owning account via `phone_number_id`/`wa_number`; unresolvable → quarantine org `unassigned` (never another tenant) | drop column/indexes |
| `agents`, `chatbots`, `automation_executions`, `pipelines`, `broadcasts`, `message_templates`, `media_library` | `organization_id UUID NULL FK` each | `INDEX(organization_id)` each | owner's personal org | drop columns |
| `webhook_events` | `organization_id UUID NULL FK` + `resolved_account_id` | `INDEX(organization_id, payload_kind)` | resolve via `phone_number_id` at backfill time; leave NULL where unresolvable | drop columns |

Enforcement sequence per table: add NULLABLE → backfill → verify zero NULLs →
`SET NOT NULL` → add FK. Each step is its own migration file so a failure aborts
boot (per `migrate.js` fail-closed behavior) without partial enforcement.

### 3.3 New `conversations` model (persistent AI mode lives here, §13)
| Item | Detail |
| ---- | ------ |
| Model | `conversations(id UUID PK, organization_id FK, whatsapp_account_id FK, contact ref (wa_number, contact_number), lead_id FK NULL, ai_enabled BOOLEAN NOT NULL DEFAULT true, last_message_at TIMESTAMPTZ, unread_count INT NOT NULL DEFAULT 0, created_at, updated_at; UNIQUE(organization_id, whatsapp_account_id, contact_number))` |
| Index | `INDEX(organization_id, last_message_at DESC)` for inbox ordering |
| Backfill | one row per distinct `(wa_number, contact_number)` in `chat_history`, stamped to the resolved org, `ai_enabled=true` (preserves current always-on-agent behavior), `unread_count` derived from `conversation_reads` where present |
| Tenant implication | inbox queries become `WHERE organization_id=$1`; AI router checks `ai_enabled` before enqueueing |
| Rollback | drop table (inbox falls back to distinct-contact query; AI flag lost → AI on) |

### 3.4 New `leads` model (tenant-scoped phone matching, §9)
| Item | Detail |
| ---- | ------ |
| Model | `leads(id UUID PK, organization_id FK, phone (digits-only normalized), name NULL, status, stage/pipeline refs, score INT NULL, qualification JSONB NULL (only model-confident values; unconfident → NULL per §12), source='whatsapp', contact ref, created_at, updated_at; UNIQUE(organization_id, phone))` |
| Backfill | one lead per distinct org-scoped contact number from `contacts`; `score NULL`, `qualification '{}'`, `status='new'` — never fabricate scores for historic rows |
| Tenant implication | lookup is always `(organization_id, normalized_phone)`; phone alone never resolves |
| Rollback | drop table (contacts remain the CRM record; no data loss) |

### 3.5 New AI quota/usage models (§14 credit safety)
| Item | Detail |
| ---- | ------ |
| Model | `ai_usage_ledger(id UUID PK, organization_id FK, agent_id NULL, contact_number NULL, inbound_message_id UNIQUE (idempotency key per §14), model, tokens_in/out, cost_credits, created_at)` |
| Model | `organization_ai_quotas(organization_id PK FK, period, credits_granted, credits_used, updated_at)` (or derive `credits_used` from the ledger — decide at implementation; ledger is source of truth either way) |
| Index | `INDEX(organization_id, created_at DESC)` on ledger |
| Backfill | none (ledger starts empty; opening balances set from plan defaults) |
| Tenant implication | pre-execution check `credits_used < credits_granted` per org; exhausted → downgrade to no-AI path + team notification; duplicate webhook retries hit the `inbound_message_id` unique key and skip |
| Rollback | drop tables (AI runs unmetered — must not operate in production without them) |

### 3.6 Webhook tenant-resolution support
- Add `organizations.meta_app_secret_encrypted` (per-org HMAC secret; closes the
  warn-only gap noted in the adoption map §2.1) and
  `organizations.webhook_verify_token_encrypted` (or keep per-account verify
  tokens and join through the account — prefer per-account to preserve current
  Meta wiring; decision required at approval).
- Webhook flow becomes: raw body → HMAC with candidate org secret(s) resolved by
  `phone_number_id` → org → scoped processing. Until this ships, the current
  global-secret behavior must NOT serve multi-tenant traffic.

## 4. What is deliberately NOT proposed
- No Prisma migration (the target stack's ORM decision belongs to the Green Pilot
  SaaS program, not to this engine tree).
- No destructive changes: no `DROP TABLE/COLUMN`, no type rewrites, no PK
  changes on `chat_history`/`contacts`, no removal of the singleton guard
  (`041`) until per-org accounts ship (removing it early would permit a second
  unowned account).
- No advertising tables, no ad-attribution columns, no spend/ROAS fields (§2 boundary).

## 5. Approval checklist (required before any migration is written)
1. [ ] Commercial license exception for SaaS use obtained (hard-stop #1).
2. [ ] Target decision: evolve this tree vs. build Green Pilot SaaS separately
   (hard-stops #5/#6).
3. [ ] Per-account vs per-org webhook secret placement (§3.6) decided.
4. [ ] Backfill owner mapping for pre-existing rows confirmed (single-owner → personal orgs).
5. [ ] `unassigned`-quarantine handling for unresolvable historic rows agreed.
6. [ ] AI quota source-of-truth (ledger vs quota table) decided.
