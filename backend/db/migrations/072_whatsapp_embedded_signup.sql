-- 072_whatsapp_embedded_signup.sql — Phase 2: Meta WhatsApp Embedded Signup v4 (ADDITIVE ONLY).
--
-- Adds Embedded Signup v4 tracking and metadata columns to coexistence.whatsapp_accounts:
--   * business_id: Meta Business Manager ID
--   * connection_status: 'connected', 'disconnected', 'pending'
--   * metadata: JSONB for quality rating, code verification status, currency, etc.
--   * disconnected_at: timestamp when connection was safely deactivated
--
-- No existing account, token, contact, or message is modified or deleted.
-- Rollback:
--   DROP INDEX IF EXISTS coexistence.idx_whatsapp_accounts_org_status;
--   ALTER TABLE coexistence.whatsapp_accounts
--     DROP COLUMN IF EXISTS business_id,
--     DROP COLUMN IF EXISTS connection_status,
--     DROP COLUMN IF EXISTS metadata,
--     DROP COLUMN IF EXISTS disconnected_at;

ALTER TABLE coexistence.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS business_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS connection_status TEXT NOT NULL DEFAULT 'connected',
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_org_status
  ON coexistence.whatsapp_accounts (organization_id, connection_status);
