-- 067_ai_qualification.sql — Phase 9 AI Lead Qualification (ADDITIVE ONLY).
--
-- - ai_models gains NULLABLE organization_id (NULL = legacy global fallback,
--   dual-read; stamped rows are owner-org visible). No rows touched.
-- - agents gains qualify_leads (opt-in qualification trigger) +
--   qualification_rules (org-owned extraction guidance). Defaults keep current
--   behavior (no qualification runs until an operator enables it).
-- - lead_qualifications stores validated qualification results only (never raw
--   model output / chain-of-thought). UNIQUE(org, inbound_message_id) is the
--   duplicate-processing guard.
-- Rollback: DROP TABLE lead_qualifications; DROP COLUMNs (refuse when rows
-- depend on them in production).

ALTER TABLE coexistence.ai_models
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES coexistence.organizations(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_ai_models_org
  ON coexistence.ai_models (organization_id);

ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS qualify_leads BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS qualification_rules TEXT;

CREATE TABLE IF NOT EXISTS coexistence.lead_qualifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES coexistence.organizations(id) ON DELETE RESTRICT,
  conversation_id     UUID REFERENCES coexistence.conversations(id) ON DELETE SET NULL,
  wa_number           TEXT NOT NULL,
  contact_number      TEXT NOT NULL,
  agent_id            BIGINT REFERENCES coexistence.agents(id) ON DELETE SET NULL,
  agent_run_id        BIGINT REFERENCES coexistence.agent_runs(id) ON DELETE SET NULL,
  inbound_message_id  TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'unknown',
  score               INTEGER,
  intent              TEXT,
  summary             TEXT,
  evaluated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lead_qualifications_status CHECK (status IN ('qualified', 'unqualified', 'needs-more-information', 'unknown')),
  CONSTRAINT lead_qualifications_score CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  CONSTRAINT lead_qualifications_idempotent UNIQUE (organization_id, inbound_message_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_qualifications_org_recent
  ON coexistence.lead_qualifications (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_qualifications_conversation
  ON coexistence.lead_qualifications (organization_id, wa_number, contact_number);
