-- Green Pilot Phase 6: AI Conversation State + Production Indexes
-- Adds missing qualification state columns and performance indexes.
-- Columns ai_enabled (conversations) and agent_paused (contacts) already
-- exist from migration 058. This migration adds the rest.
--
-- All changes are additive and idempotent (IF NOT EXISTS / DO NOTHING).

-- ── 1. conversations: additional AI tracking columns ───────────────────────
-- ai_enabled already exists from migration 058
ALTER TABLE coexistence.conversations
  ADD COLUMN IF NOT EXISTS ai_last_action_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qualification_status TEXT
    CHECK (qualification_status IN ('qualified','unqualified','needs-more-information','unknown') OR qualification_status IS NULL),
  ADD COLUMN IF NOT EXISTS last_qualification_score INTEGER;

-- ── 2. Performance indexes ─────────────────────────────────────────────────

-- Inbox: chat list sorted by recent activity (primary hot path)
CREATE INDEX IF NOT EXISTS idx_conversations_org_last_message
  ON coexistence.conversations (organization_id, last_message_at DESC NULLS LAST);

-- Inbox: message history for a conversation (chat window)
CREATE INDEX IF NOT EXISTS idx_chat_history_org_wa_contact_ts
  ON coexistence.chat_history (organization_id, wa_number, contact_number, timestamp DESC);

-- Webhook: account resolution from phone_number_id (called on every inbound)
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_phone_number_id
  ON coexistence.whatsapp_accounts (phone_number_id)
  WHERE phone_number_id IS NOT NULL;

-- Webhook: account resolution from waba_id (fallback)
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_waba_id
  ON coexistence.whatsapp_accounts (waba_id)
  WHERE waba_id IS NOT NULL;

-- AI dedup: qualification existence check on inbound message
CREATE INDEX IF NOT EXISTS idx_lead_qualifications_org_message
  ON coexistence.lead_qualifications (organization_id, inbound_message_id)
  WHERE inbound_message_id IS NOT NULL;

-- AI billing dedup: usage record lookup (hasAiUsage)
CREATE INDEX IF NOT EXISTS idx_ai_usage_org_message
  ON coexistence.ai_usage_ledger (organization_id, inbound_message_id)
  WHERE inbound_message_id IS NOT NULL;

-- Agent queue: recent runs by contact (trigger session check)
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_contact_started
  ON coexistence.agent_runs (agent_id, contact_number, started_at DESC);

-- Webhook audit: query by phone_number_id
CREATE INDEX IF NOT EXISTS idx_webhook_events_phone_number_id
  ON coexistence.webhook_events (phone_number_id)
  WHERE phone_number_id IS NOT NULL;
