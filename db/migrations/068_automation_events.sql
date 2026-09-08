-- 068_automation_events.sql — Phase 10 automation idempotency + depth (ADDITIVE ONLY).
--
-- automation_executions gains:
--   event_id       — deterministic identity of the triggering event
--                    (message_id, qualification id, follow-up key, ...).
--   depth          — event-cascade depth (loop protection, default 0).
--   test_mode      — manual test runs (simulated side effects, auditable).
-- The UNIQUE(org, automation, event) makes re-delivery of the same event for
-- the same automation a no-op. Legacy rows (NULL org/event) never conflict
-- (NULLs are distinct), so the constraint cannot break existing history.
-- Rollback: DROP CONSTRAINT + DROP COLUMNs (refuse when rows depend on them).

ALTER TABLE coexistence.automation_executions
  ADD COLUMN IF NOT EXISTS event_id TEXT;
ALTER TABLE coexistence.automation_executions
  ADD COLUMN IF NOT EXISTS depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE coexistence.automation_executions
  ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'automation_executions_idempotent'
  ) THEN
    ALTER TABLE coexistence.automation_executions
      ADD CONSTRAINT automation_executions_idempotent
      UNIQUE (organization_id, automation_id, event_id);
  END IF;
END $$;
