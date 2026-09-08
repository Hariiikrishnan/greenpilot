-- Green Pilot — Phase 3: WhatsApp Provisioning & Explicit Connection States
--
-- Formalizes:
-- 1. Canonical connection status states: PENDING, CONNECTING, CONNECTED, ERROR, DISCONNECTED
-- 2. Webhook subscription tracking columns: webhook_subscribed, webhook_verified_at
-- 3. Registration timestamp: registered_at

-- Normalize existing lowercase values to canonical uppercase
UPDATE coexistence.whatsapp_accounts
   SET connection_status = UPPER(connection_status)
 WHERE connection_status IS NOT NULL;

-- Default any null or unexpected status to CONNECTED if active, otherwise DISCONNECTED
UPDATE coexistence.whatsapp_accounts
   SET connection_status = CASE WHEN is_active THEN 'CONNECTED' ELSE 'DISCONNECTED' END
 WHERE connection_status NOT IN ('PENDING', 'CONNECTING', 'CONNECTED', 'ERROR', 'DISCONNECTED');

-- Add CHECK constraint for explicit states
ALTER TABLE coexistence.whatsapp_accounts
  DROP CONSTRAINT IF EXISTS whatsapp_accounts_connection_status_check;

ALTER TABLE coexistence.whatsapp_accounts
  ADD CONSTRAINT whatsapp_accounts_connection_status_check
  CHECK (connection_status IN ('PENDING', 'CONNECTING', 'CONNECTED', 'ERROR', 'DISCONNECTED'));

-- Add webhook subscription verification columns
ALTER TABLE coexistence.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS webhook_subscribed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE coexistence.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS webhook_verified_at TIMESTAMPTZ;

ALTER TABLE coexistence.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ;

-- Backfill webhook_subscribed for already active accounts so existing functional accounts remain functional
UPDATE coexistence.whatsapp_accounts
   SET webhook_subscribed = TRUE,
       webhook_verified_at = NOW()
 WHERE is_active = TRUE AND connection_status = 'CONNECTED';
