-- 063_new_tenant_tables.sql — Green Pilot Tier 1–3 tables (EMPTY AT CREATION).
--
-- New tables ship with NOT NULL organization FKs (ON DELETE RESTRICT — deleting
-- an org with customer data is refused; data is never cascade-deleted) because
-- they start empty: no backfill, no ambiguity, nothing to orphan.
--   conversations        — Tier 1: inbox thread + persistent ai_enabled flag (§13/Step 8)
--   ai_usage_ledger      — Tier 1: quota + idempotency (UNIQUE org+message)
--   lead_notes           — Tier 2: CRM notes
--   lead_calls           — Tier 2: call log
--   follow_ups           — Tier 2: scheduled follow-ups
--   billing_subscriptions— Tier 3: org billing ownership (provider integration staged)
-- Rollback: DROP TABLE in reverse creation order (all empty by definition here;
--   in production, refuse rollback when rows exist — see report).

CREATE TABLE IF NOT EXISTS coexistence.conversations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES coexistence.organizations(id) ON DELETE RESTRICT,
  whatsapp_account_id BIGINT REFERENCES coexistence.whatsapp_accounts(id) ON DELETE RESTRICT,
  wa_number           TEXT NOT NULL,
  contact_number      TEXT NOT NULL,
  lead_contact_ref    TEXT,
  ai_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  last_message_at     TIMESTAMPTZ,
  unread_count        INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT conversations_unique_thread UNIQUE (organization_id, whatsapp_account_id, contact_number)
);
CREATE INDEX IF NOT EXISTS idx_conversations_org_recent
  ON coexistence.conversations (organization_id, last_message_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS coexistence.ai_usage_ledger (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES coexistence.organizations(id) ON DELETE RESTRICT,
  agent_id            BIGINT REFERENCES coexistence.agents(id) ON DELETE SET NULL,
  contact_number      TEXT,
  inbound_message_id  TEXT NOT NULL,
  model               TEXT,
  tokens_in           INTEGER NOT NULL DEFAULT 0,
  tokens_out          INTEGER NOT NULL DEFAULT 0,
  cost_credits        INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_usage_idempotent UNIQUE (organization_id, inbound_message_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_org_recent
  ON coexistence.ai_usage_ledger (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coexistence.lead_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES coexistence.organizations(id) ON DELETE RESTRICT,
  contact_ref     TEXT,
  body            TEXT NOT NULL,
  created_by      BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_org
  ON coexistence.lead_notes (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coexistence.lead_calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES coexistence.organizations(id) ON DELETE RESTRICT,
  contact_ref     TEXT,
  outcome         TEXT,
  notes           TEXT,
  created_by      BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_calls_org
  ON coexistence.lead_calls (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coexistence.follow_ups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES coexistence.organizations(id) ON DELETE RESTRICT,
  contact_ref     TEXT,
  due_at          TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  assigned_to     BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT follow_ups_status CHECK (status IN ('pending', 'done', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_org_due
  ON coexistence.follow_ups (organization_id, due_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS coexistence.billing_subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL UNIQUE REFERENCES coexistence.organizations(id) ON DELETE RESTRICT,
  plan                TEXT NOT NULL DEFAULT 'trial',
  status              TEXT NOT NULL DEFAULT 'active',
  provider            TEXT,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  current_period_end  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_status CHECK (status IN ('active', 'past_due', 'cancelled', 'trialing'))
);
