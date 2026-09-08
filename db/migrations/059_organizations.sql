-- 059_organizations.sql — Green Pilot multi-tenancy root (ADDITIVE ONLY).
--
-- Creates the Organization + Membership tables. No existing table is altered,
-- no data is touched. Seeding personal orgs for existing users is a separate,
-- approval-gated step (see PHASE5_DATABASE_EVOLUTION_PLAN.md) — this file only
-- creates empty tables so the tenancy code has a fail-closed foundation.
-- Rollback: DROP TABLE coexistence.organization_members, coexistence.organizations;

-- gen_random_uuid() is core in PostgreSQL 13+; keep the extension line as a
-- safety net for older servers. Idempotent either way.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS coexistence.organizations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  slug               TEXT NOT NULL UNIQUE,
  plan               TEXT NOT NULL DEFAULT 'trial',
  ai_credits_granted INTEGER NOT NULL DEFAULT 0,
  ai_credits_used    INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

CREATE TABLE IF NOT EXISTS coexistence.organization_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES coexistence.organizations(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL REFERENCES coexistence.forgecrm_users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT organization_members_role CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT organization_members_unique UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user
  ON coexistence.organization_members (user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org
  ON coexistence.organization_members (organization_id);
