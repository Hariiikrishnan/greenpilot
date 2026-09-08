-- 070_onboarding_settings.sql — Phase 12 SaaS onboarding + org settings (ADDITIVE ONLY).
--
-- Adds server-persisted onboarding state + org profile columns, a secure
-- invitation table, and an idempotency ledger for org creation retries.
-- No existing table is altered beyond ADD COLUMN; no data is touched.
-- Rollback: DROP TABLE coexistence.organization_invitations,
--   coexistence.idempotency_keys; ALTER TABLE coexistence.organizations
--   DROP COLUMN onboarding_state, DROP COLUMN onboarding_completed_at,
--   DROP COLUMN timezone, DROP COLUMN locale, DROP COLUMN business_name;

-- Onboarding + org profile columns (all nullable-safe, backfilled by default).
ALTER TABLE coexistence.organizations
  ADD COLUMN IF NOT EXISTS onboarding_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS business_name TEXT NULL;

-- Secure email invitations: token is stored as SHA-256 hex (token_hash);
-- the raw token is shown once at creation and never persisted.
CREATE TABLE IF NOT EXISTS coexistence.organization_invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES coexistence.organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member',
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ NULL,
  revoked_at      TIMESTAMPTZ NULL,
  created_by      BIGINT NULL REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT organization_invitations_role CHECK (role IN ('admin', 'member'))
);

CREATE INDEX IF NOT EXISTS idx_org_invitations_org
  ON coexistence.organization_invitations (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_invitations_email
  ON coexistence.organization_invitations (email);

-- Idempotency ledger for safe retry of POST /v1/orgs (and register).
-- Key scope: (user_id, endpoint, client_key). Response is the JSON sent
-- on the first attempt so retries replay it byte-identically.
CREATE TABLE IF NOT EXISTS coexistence.idempotency_keys (
  user_id     BIGINT NOT NULL REFERENCES coexistence.forgecrm_users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  client_key  TEXT NOT NULL,
  status      INTEGER NOT NULL DEFAULT 201,
  response    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT idempotency_keys_unique UNIQUE (user_id, endpoint, client_key)
);
