-- 060_whatsapp_account_org.sql — stage-1 WhatsApp ownership (ADDITIVE ONLY).
--
-- Adds a NULLABLE organization owner to whatsapp_accounts. NULL = legacy
-- single-owner scope (dual-read by the service layer until the approval-gated
-- backfill assigns every account to its owner's personal org — see
-- PHASE5_DATABASE_EVOLUTION_PLAN.md). No rows are updated by this file.
-- Rollback: DROP INDEX coexistence.idx_wa_accounts_org;
--           ALTER TABLE coexistence.whatsapp_accounts DROP COLUMN organization_id;

ALTER TABLE coexistence.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS organization_id UUID
    REFERENCES coexistence.organizations(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_wa_accounts_org
  ON coexistence.whatsapp_accounts (organization_id);
