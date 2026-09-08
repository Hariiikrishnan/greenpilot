-- 074_whatsapp_connection_status_default.sql
-- Fixes connection_status column default to canonical 'CONNECTED' and ensures case-insensitive check

ALTER TABLE coexistence.whatsapp_accounts
  ALTER COLUMN connection_status SET DEFAULT 'CONNECTED';

ALTER TABLE coexistence.whatsapp_accounts
  DROP CONSTRAINT IF EXISTS whatsapp_accounts_connection_status_check;

ALTER TABLE coexistence.whatsapp_accounts
  ADD CONSTRAINT whatsapp_accounts_connection_status_check
  CHECK (UPPER(connection_status) IN ('PENDING', 'CONNECTING', 'CONNECTED', 'ERROR', 'DISCONNECTED'));
