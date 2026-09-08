-- 071_google_auth.sql — Phase 1: Google Primary Authentication (ADDITIVE ONLY).
--
-- Adds Google identity columns to coexistence.forgecrm_users:
--   * google_subject: Google's immutable sub identifier (unique, indexed)
--   * avatar_url: profile picture URL from Google Identity Services
--   * email_verified: boolean verification flag from identity provider
--
-- No existing user, password, role, or organization is altered or deleted.
-- Rollback:
--   DROP INDEX IF EXISTS coexistence.idx_forgecrm_users_google_sub;
--   ALTER TABLE coexistence.forgecrm_users
--     DROP COLUMN IF EXISTS google_subject,
--     DROP COLUMN IF EXISTS avatar_url,
--     DROP COLUMN IF EXISTS email_verified;

ALTER TABLE coexistence.forgecrm_users
  ADD COLUMN IF NOT EXISTS google_subject TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_forgecrm_users_google_sub
  ON coexistence.forgecrm_users (google_subject)
  WHERE google_subject IS NOT NULL;
