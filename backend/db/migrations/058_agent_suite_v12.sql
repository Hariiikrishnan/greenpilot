-- 058_agent_suite_v12.sql
-- Add agent handoff, auto close summary, and CRM tool settings to coexistence.agents
-- and conversation state tracking to coexistence.contacts.

ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS crm_tools_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS handoff_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS handoff_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS handoff_keywords TEXT,
  ADD COLUMN IF NOT EXISTS close_summary_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS close_idle_minutes INT NOT NULL DEFAULT 30;

ALTER TABLE coexistence.contacts
  ADD COLUMN IF NOT EXISTS agent_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS agent_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS agent_paused_by TEXT,
  ADD COLUMN IF NOT EXISTS agent_close_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS agent_last_run_at TIMESTAMPTZ;
