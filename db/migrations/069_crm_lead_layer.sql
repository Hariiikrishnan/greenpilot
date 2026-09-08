-- 069_crm_lead_layer.sql — Phase 11 canonical lead layer (ADDITIVE ONLY).
--
-- Lead ≡ contact (composite (wa_number, contact_number) identity, org-owned).
-- No new lead table: every system already keys on the contact pair, and a
-- parallel table would duplicate identity. This migration adds only:
--   contacts.lead_status       — operator-controlled status (NULL reads as
--                                 'new'; validated against the canonical enum
--                                 in src/crm/service.js, NOT by CHECK, so the
--                                 vocabulary can evolve without migrations).
--   contacts.pipeline_stage_id — optional link into the lead's pipeline stage
--                                 (SET NULL if the stage is deleted; deals keep
--                                 their own independent stage linkage).
--   lead_activities            — operator-action audit (created / status /
--                                 stage / assigned). Notes/calls/follow-ups/
--                                 qualifications/messages/automations union
--                                 into the timeline from their own tables —
--                                 they are NOT duplicated here.
-- Rollback: DROP TABLE lead_activities; DROP COLUMNs (refuse when rows depend).

ALTER TABLE coexistence.contacts
  ADD COLUMN IF NOT EXISTS lead_status TEXT;
ALTER TABLE coexistence.contacts
  ADD COLUMN IF NOT EXISTS pipeline_stage_id BIGINT REFERENCES coexistence.pipeline_stages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_stage
  ON coexistence.contacts (organization_id, pipeline_stage_id);

CREATE TABLE IF NOT EXISTS coexistence.lead_activities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES coexistence.organizations(id) ON DELETE RESTRICT,
  wa_number           TEXT NOT NULL,
  contact_number      TEXT NOT NULL,
  kind                TEXT NOT NULL,
  summary             TEXT,
  actor_user_id       BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lead_activities_kind CHECK (kind IN ('created', 'status', 'stage', 'assigned'))
);
CREATE INDEX IF NOT EXISTS idx_lead_activities_org_contact
  ON coexistence.lead_activities (organization_id, wa_number, contact_number, created_at DESC);
