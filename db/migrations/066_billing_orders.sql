-- 066_billing_orders.sql — Phase 8 billing foundation (ADDITIVE ONLY).
--
-- Extends the 063 billing_subscriptions stub into a working org-owned
-- subscription/order system. Nothing existing is altered destructively:
--   - billing_orders is a NEW table (starts empty, org FK RESTRICT).
--   - billing_status CHECK is replaced by a SUPERSET (all four legacy values
--     remain valid; adds expired/suspended/trial). Transactional, validates.
--   - ai_usage_ledger gains a NULLABLE user_id ("user where applicable").
--   - billing_subscriptions gains NULLABLE trial_ends_at (trial window).
-- Rollback: DROP TABLE billing_orders; re-add the legacy CHECK;
--   DROP COLUMN trial_ends_at / user_id (refuse when rows depend on them).

CREATE TABLE IF NOT EXISTS coexistence.billing_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES coexistence.organizations(id) ON DELETE RESTRICT,
  provider            TEXT NOT NULL DEFAULT 'razorpay',
  provider_order_id   TEXT UNIQUE,
  receipt             TEXT NOT NULL UNIQUE,
  plan                TEXT NOT NULL,
  amount_paise        INTEGER NOT NULL CONSTRAINT billing_orders_amount_nonneg CHECK (amount_paise >= 0),
  currency            TEXT NOT NULL DEFAULT 'INR',
  status              TEXT NOT NULL DEFAULT 'created',
  provider_payment_id TEXT,
  verified_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_orders_status CHECK (status IN ('created', 'paid', 'failed', 'expired', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_billing_orders_org_recent
  ON coexistence.billing_orders (organization_id, created_at DESC);

-- Superset status CHECK (legacy: active/past_due/cancelled/trialing).
ALTER TABLE coexistence.billing_subscriptions DROP CONSTRAINT IF EXISTS billing_status;
ALTER TABLE coexistence.billing_subscriptions
  ADD CONSTRAINT billing_status CHECK (status IN ('active', 'past_due', 'cancelled', 'trialing', 'expired', 'suspended', 'trial'));

ALTER TABLE coexistence.billing_subscriptions
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

ALTER TABLE coexistence.ai_usage_ledger
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL;
