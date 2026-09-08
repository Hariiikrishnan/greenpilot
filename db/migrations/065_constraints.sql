-- 065_constraints.sql — FKs, indexes, tenant-scoped uniqueness (APPROVED B1).
--
-- 1) Removes the structural single-account blockers so Org A → WA-A and
--    Org B → WA-B can coexist (Step 7; hard-stop #5 would otherwise fire):
--      DROP whatsapp_accounts_singleton  (UNIQUE(true) — forbids a 2nd row, ever)
--      DROP idx_whatsapp_accounts_one_default (global single default)
--    and replaces the latter with a PER-ORG default guard. Index drops only —
--    no rows touched.
-- 2) Enforces organization_id → organizations(id) ON DELETE RESTRICT everywhere
--    (orgs with customer data cannot be deleted; nothing cascade-deletes).
-- 3) Adds per-table org indexes + tenant-scoped uniques.
-- Uniqueness review (Step 6): phone_number_id stays GLOBAL (Meta-issued, cannot
--   repeat across orgs); chat_history.message_id stays GLOBAL (wamids are
--   globally unique; dedupe depends on it); contacts(wa_number,contact_number)
--   stays GLOBAL (a second org reusing the pair would collide on the same
--   business number — revisited only with conflict evidence); agents
--   one-active-per-account already scopes transitively via the account.
-- Fail-closed: FK validation raises EXCEPTION on dangling org refs.
-- Rollback: DROP the added indexes/constraints (named below); re-create the
--   singleton guard ONLY on single-row tables (otherwise it cannot apply).

-- 1) Structural singleton removal (data-preserving: indexes only).
DROP INDEX IF EXISTS coexistence.whatsapp_accounts_singleton;
DROP INDEX IF EXISTS coexistence.idx_whatsapp_accounts_one_default;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_accounts_one_default_per_org
  ON coexistence.whatsapp_accounts (organization_id, is_default)
  WHERE is_default = TRUE;

-- Per-org account identity (phone_number_id remains globally unique by Meta issuance).
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_accounts_org_number
  ON coexistence.whatsapp_accounts (organization_id, phone_number_id);

-- 2) FK validation + enforcement.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT organization_id FROM coexistence.whatsapp_accounts WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.contacts WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.chat_history WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.agents WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.agent_runs WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.chatbots WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.automation_executions WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.message_templates WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.broadcasts WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.broadcast_logs WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.media_library WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.pipelines WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.pipeline_stages WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.deals WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.oauth_credentials WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.webhook_events WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.conversation_reads WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.message_reactions WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.wa_links WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM coexistence.user_audit_log WHERE organization_id IS NOT NULL
    ) o
    LEFT JOIN coexistence.organizations g ON g.id = o.organization_id
    WHERE g.id IS NULL
  ) THEN RAISE EXCEPTION 'constraints: dangling organization_id reference(s) — refusing FK creation'; END IF;
END $$;

-- NOTE: whatsapp_accounts already carries its org FK + index from 060 and is
-- therefore excluded from the loop below (re-adding would duplicate them).
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'contacts', 'chat_history', 'agents', 'agent_runs',
    'chatbots', 'automation_executions',
    'message_templates', 'broadcasts', 'broadcast_logs', 'media_library',
    'pipelines', 'pipeline_stages', 'deals',
    'oauth_credentials', 'webhook_events',
    'conversation_reads', 'message_reactions', 'wa_links', 'user_audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE coexistence.%I ADD CONSTRAINT %I FOREIGN KEY (organization_id) REFERENCES coexistence.organizations(id) ON DELETE RESTRICT NOT VALID',
      t, t || '_org_fk'
    );
    EXECUTE format(
      'ALTER TABLE coexistence.%I VALIDATE CONSTRAINT %I',
      t, t || '_org_fk'
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON coexistence.%I (organization_id)',
      'idx_' || t || '_org', t
    );
  END LOOP;
END $$;
