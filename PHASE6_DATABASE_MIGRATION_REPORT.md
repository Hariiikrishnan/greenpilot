# PHASE 6 — Database Migration Report (061–065)

> Applied 2026-09-05 via production boot runner on the dev database (ledgered;
> `61 already present, 5 applied`). Additive except index-only singleton removal.

## Files
- `061_org_seed.sql` — per-user workspace org + owner membership; fail-closed
  count validation; guarded rollback documented in-file.
- `062_org_columns.sql` — nullable `organization_id` (no FK) on 19 tenant tables.
- `063_new_tenant_tables.sql` — `conversations` (UNIQUE org/account/contact,
  `ai_enabled`), `ai_usage_ledger` (UNIQUE org/message), `lead_notes`,
  `lead_calls`, `follow_ups`, `billing_subscriptions` (UNIQUE org) — all NOT NULL
  org FK RESTRICT, empty at creation.
- `064_backfill.sql` — Rules A–K (deterministic) + per-rule EXCEPTION validators
  + remainder NOTICE census.
- `065_constraints.sql` — singleton removal, per-org default guard, FKs, indexes.

## Foreign keys (29 org FKs, verified live)
- 20 stage-1 tables: `..._org_fk`, `REFERENCES organizations(id) ON DELETE RESTRICT`,
  added NOT VALID → VALIDATEd (zero dangling confirmed by pre-check).
- `whatsapp_accounts`: pre-existing FK from 060 (RESTRICT).
- 6 new tables: inline NOT NULL FKs (RESTRICT; memberships use CASCADE to
  user/org lifecycle; ledger agent ref SET NULL).
- ON UPDATE: default (no cascading updates — UUID PKs immutable in practice).
- No cascade path can delete customer data (RESTRICT everywhere except
  membership lifecycle rows).

## Indexes
- `idx_<table>_org` on all 20 stage-1 tables + 060's `idx_wa_accounts_org`.
- Purpose-built: `idx_conversations_org_recent`, `idx_ai_usage_org_recent`,
  `idx_lead_notes/calls_org`, `idx_follow_ups_org_due` (partial pending),
  `idx_wa_accounts_org_number`.

## Uniqueness (Step 6 review)
- REMOVED: `whatsapp_accounts_singleton` (UNIQUE(true) — forbade any 2nd row),
  global `one_default` partial unique.
- ADDED: per-org default guard `(organization_id, is_default) WHERE is_default`
  (NULL-org legacy rows stay mutually distinct), per-org
  `(organization_id, phone_number_id)`, conversation thread unique, ledger
  idempotency unique.
- KEPT GLOBAL (justified): `phone_number_id` (Meta-issued, cannot repeat),
  `message_id` (wamid dedupe depends on global uniqueness),
  `contacts(wa_number,contact_number)` (same business number pair cannot span
  orgs; revisit only with conflict evidence), agent one-active-per-account
  (transitively per-org). No cross-tenant conflicts exist in data (verified).

## Ownership chains now enforced by schema
- Org → account(s) → conversation(s) → message(s) (Steps 7–8): FKs + thread
  unique + write-time stamping (webhook inbound, `insertPendingRow` outbound).
- Org → automations/executions (Step 9): columns + FKs + job-context stamping
  (`enqueueSend` resolution, `enqueueAgentRun` routing) + worker re-validation.
- Org → agents/ledger (Step 10): columns + FKs + router gate + worker refusal.
- Org → billing (Tier 3): `billing_subscriptions` UNIQUE-org + plan/quota fields
  on `organizations` (provider integration staged — B3).
- Exceptions (documented, no org column): `ai_models`, `google_oauth_credentials`,
  `mcp_*` (global), taxonomy tables (shared reference, duplication staged),
  `user_audit_log` (immutable trail), frozen legacy tables.

## Data-access changes (Step 11)
- New `tenancy/scope.js`: `orgIdFrom`, `requireOrgId`, `assertOrgRow`
  (org-or-legacy dual-read, null → 404), `orgFilterClause`, `tenantJobAllowed`.
- Wired: WhatsApp credential resolution carries `organizationId`; webhook
  inbound stamps org + maintains org-owned conversations; outbound rows stamped
  at insert; send/agent workers enforce job-vs-account match (mismatch fails or
  refuses, never crosses); agent router gates + stamps.
