-- 064_backfill.sql — deterministic tenant backfill (APPROVED B1, Step 2 rules).
--
-- Every UPDATE below is anchored to a defensible existing relationship
-- (account link, user link, or parent inheritance). Rows with NO defensible
-- owner are LEFT NULL and classified manual-mapping in
-- PHASE6_BACKFILL_EXECUTION_REPORT.md — never guessed.
-- Live-DB survey 2026-09-04: operational tables are EMPTY; reference rows are
--   1 agent (wa_account_id NULL → manual), 1 pipeline (created_by NULL → manual),
--   6 stages (inherit pipeline → stays NULL), 4 tags + 2 cats (shared → manual),
--   mcp_settings (global exception). Expected effect on this DB: seed-only (061)
--   with zero backfilled rows — the rules below still execute so ANY database
--   (dev/staging/prod) migrates deterministically.
-- Fail-closed: each rule ends with a validator that raises EXCEPTION if a row
--   the rule SHOULD have caught remains NULL. The boot runner aborts on error.
-- Rollback: UPDATE <table> SET organization_id = NULL WHERE <same rule scope>;
--   seeded orgs/memberships per 061 rollback. No rows deleted by this file.

-- Rule A: WhatsApp accounts ← user_wa_assignments (account number assigned to
-- exactly one user → that user's org). Multi-user/zero-user numbers stay NULL.
UPDATE coexistence.whatsapp_accounts w
   SET organization_id = sub.org_id
  FROM (
    SELECT a.phone_number_id, m.organization_id AS org_id
      FROM coexistence.whatsapp_accounts a
      JOIN coexistence.user_wa_assignments ua
        ON regexp_replace(ua.wa_number, '\D', '', 'g')
         = regexp_replace(a.display_phone_number, '\D', '', 'g')
      JOIN coexistence.organization_members m ON m.user_id = ua.user_id
     WHERE a.organization_id IS NULL
     GROUP BY a.phone_number_id, m.organization_id
    HAVING COUNT(DISTINCT m.user_id) = 1
       AND COUNT(DISTINCT m.organization_id) = 1
  ) sub
 WHERE w.phone_number_id = sub.phone_number_id
   AND w.organization_id IS NULL;

-- Rule B: agents ← owning WhatsApp account (wa_account_id → account org).
UPDATE coexistence.agents a
   SET organization_id = w.organization_id
  FROM coexistence.whatsapp_accounts w
 WHERE a.wa_account_id = w.id
   AND a.organization_id IS NULL
   AND w.organization_id IS NOT NULL;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM coexistence.agents a
    JOIN coexistence.whatsapp_accounts w ON w.id = a.wa_account_id
    WHERE a.organization_id IS NULL AND w.organization_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'backfill: agent(s) with org-owned account left unassigned'; END IF;
END $$;

-- Rule C: pipelines ← creator (created_by → member org, exactly one org).
UPDATE coexistence.pipelines p
   SET organization_id = sub.org_id
  FROM (
    SELECT p2.id, m.organization_id AS org_id
      FROM coexistence.pipelines p2
      JOIN coexistence.organization_members m ON m.user_id = p2.created_by
     WHERE p2.organization_id IS NULL AND p2.created_by IS NOT NULL
     GROUP BY p2.id, m.organization_id
    HAVING COUNT(*) = 1
  ) sub
 WHERE p.id = sub.id AND p.organization_id IS NULL;
-- Rule C2: stages inherit their pipeline's org (parent rule).
UPDATE coexistence.pipeline_stages s
   SET organization_id = p.organization_id
  FROM coexistence.pipelines p
 WHERE s.pipeline_id = p.id
   AND s.organization_id IS NULL
   AND p.organization_id IS NOT NULL;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM coexistence.pipeline_stages s
    JOIN coexistence.pipelines p ON p.id = s.pipeline_id
    WHERE s.organization_id IS NULL AND p.organization_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'backfill: stage(s) with org-owned pipeline left unassigned'; END IF;
END $$;

-- Rule D: deals ← assignee (assigned_user_id → member org, exactly one).
UPDATE coexistence.deals d
   SET organization_id = sub.org_id
  FROM (
    SELECT d2.id, m.organization_id AS org_id
      FROM coexistence.deals d2
      JOIN coexistence.organization_members m ON m.user_id = d2.assigned_user_id
     WHERE d2.organization_id IS NULL AND d2.assigned_user_id IS NOT NULL
     GROUP BY d2.id, m.organization_id
    HAVING COUNT(*) = 1
  ) sub
 WHERE d.id = sub.id AND d.organization_id IS NULL;

-- Rule D2: deals ← creator fallback (only when no assignee claimed it).
UPDATE coexistence.deals d
   SET organization_id = sub.org_id
  FROM (
    SELECT d2.id, m.organization_id AS org_id
      FROM coexistence.deals d2
      JOIN coexistence.organization_members m ON m.user_id = d2.created_by
     WHERE d2.organization_id IS NULL AND d2.created_by IS NOT NULL
     GROUP BY d2.id, m.organization_id
    HAVING COUNT(*) = 1
  ) sub
 WHERE d.id = sub.id AND d.organization_id IS NULL;

-- Rule E: oauth credentials ← owning user (user_id → member org, exactly one).
UPDATE coexistence.oauth_credentials o
   SET organization_id = sub.org_id
  FROM (
    SELECT o2.user_id, m.organization_id AS org_id
      FROM coexistence.oauth_credentials o2
      JOIN coexistence.organization_members m ON m.user_id = o2.user_id
     WHERE o2.organization_id IS NULL
     GROUP BY o2.user_id, m.organization_id
    HAVING COUNT(*) = 1
  ) sub
 WHERE o.user_id = sub.user_id AND o.organization_id IS NULL;

-- Rule F: contacts + chat_history ← business number → account org.
UPDATE coexistence.contacts c
   SET organization_id = w.organization_id
  FROM coexistence.whatsapp_accounts w
 WHERE regexp_replace(c.wa_number, '\D', '', 'g')
     = regexp_replace(w.display_phone_number, '\D', '', 'g')
   AND c.organization_id IS NULL
   AND w.organization_id IS NOT NULL
   AND w.display_phone_number IS NOT NULL AND w.display_phone_number <> '';
UPDATE coexistence.chat_history h
   SET organization_id = w.organization_id
  FROM coexistence.whatsapp_accounts w
 WHERE (regexp_replace(h.wa_number, '\D', '', 'g')
      = regexp_replace(w.display_phone_number, '\D', '', 'g')
        OR h.phone_number_id = w.phone_number_id)
   AND h.organization_id IS NULL
   AND w.organization_id IS NOT NULL;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM coexistence.contacts c
    JOIN coexistence.whatsapp_accounts w
      ON regexp_replace(c.wa_number, '\D', '', 'g')
       = regexp_replace(w.display_phone_number, '\D', '', 'g')
    WHERE c.organization_id IS NULL AND w.organization_id IS NOT NULL
      AND w.display_phone_number IS NOT NULL AND w.display_phone_number <> ''
  ) THEN RAISE EXCEPTION 'backfill: contact(s) with org-owned account left unassigned'; END IF;
END $$;

-- Rule G: templates + media library ← owning account.
UPDATE coexistence.message_templates t
   SET organization_id = w.organization_id
  FROM coexistence.whatsapp_accounts w
 WHERE t.whatsapp_account_id = w.id
   AND t.organization_id IS NULL AND w.organization_id IS NOT NULL;
UPDATE coexistence.media_library ml
   SET organization_id = w.organization_id
  FROM coexistence.whatsapp_accounts w
 WHERE ml.whatsapp_account_id = w.id
   AND ml.organization_id IS NULL AND w.organization_id IS NOT NULL;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM coexistence.message_templates t
    JOIN coexistence.whatsapp_accounts w ON w.id = t.whatsapp_account_id
    WHERE t.organization_id IS NULL AND w.organization_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'backfill: template(s) with org-owned account left unassigned'; END IF;
  IF EXISTS (
    SELECT 1 FROM coexistence.media_library ml
    JOIN coexistence.whatsapp_accounts w ON w.id = ml.whatsapp_account_id
    WHERE ml.organization_id IS NULL AND w.organization_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'backfill: media row(s) with org-owned account left unassigned'; END IF;
END $$;

-- Rule H: broadcasts ← sender number → account org; logs inherit broadcast.
UPDATE coexistence.broadcasts b
   SET organization_id = w.organization_id
  FROM coexistence.whatsapp_accounts w
 WHERE regexp_replace(b.from_number, '\D', '', 'g')
     = regexp_replace(w.display_phone_number, '\D', '', 'g')
   AND b.organization_id IS NULL AND w.organization_id IS NOT NULL
   AND b.from_number IS NOT NULL AND b.from_number <> '';
UPDATE coexistence.broadcast_logs bl
   SET organization_id = b.organization_id
  FROM coexistence.broadcasts b
 WHERE bl.broadcast_id = b.id
   AND bl.organization_id IS NULL AND b.organization_id IS NOT NULL;

-- Rule I: automation executions ← business number → account org.
-- (chatbots definitions have no owner linkage → stay NULL, manual-mapping.)
UPDATE coexistence.automation_executions e
   SET organization_id = w.organization_id
  FROM coexistence.whatsapp_accounts w
 WHERE regexp_replace(e.wa_number, '\D', '', 'g')
     = regexp_replace(w.display_phone_number, '\D', '', 'g')
   AND e.organization_id IS NULL AND w.organization_id IS NOT NULL
   AND w.display_phone_number IS NOT NULL AND w.display_phone_number <> '';

-- Rule J: webhook audit ← phone_number_id → account org (immutable trail).
UPDATE coexistence.webhook_events we
   SET organization_id = w.organization_id
  FROM coexistence.whatsapp_accounts w
 WHERE we.phone_number_id = w.phone_number_id
   AND we.organization_id IS NULL AND w.organization_id IS NOT NULL
   AND we.phone_number_id IS NOT NULL;

-- Rule K: conversations ← distinct org-scoped threads in chat_history.
INSERT INTO coexistence.conversations
  (organization_id, whatsapp_account_id, wa_number, contact_number,
   last_message_at, unread_count)
SELECT h.organization_id, w.id, h.wa_number, h.contact_number,
       MAX(h.timestamp), 0
  FROM coexistence.chat_history h
  LEFT JOIN coexistence.whatsapp_accounts w
    ON w.phone_number_id = h.phone_number_id
 WHERE h.organization_id IS NOT NULL
 GROUP BY h.organization_id, w.id, h.wa_number, h.contact_number
ON CONFLICT (organization_id, whatsapp_account_id, contact_number) DO NOTHING;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT 'agents' t, COUNT(*) n FROM coexistence.agents WHERE organization_id IS NULL
    UNION ALL SELECT 'pipelines', COUNT(*) FROM coexistence.pipelines WHERE organization_id IS NULL
    UNION ALL SELECT 'pipeline_stages', COUNT(*) FROM coexistence.pipeline_stages WHERE organization_id IS NULL
    UNION ALL SELECT 'contacts', COUNT(*) FROM coexistence.contacts WHERE organization_id IS NULL
    UNION ALL SELECT 'chat_history', COUNT(*) FROM coexistence.chat_history WHERE organization_id IS NULL
    UNION ALL SELECT 'whatsapp_accounts', COUNT(*) FROM coexistence.whatsapp_accounts WHERE organization_id IS NULL
    UNION ALL SELECT 'chatbots', COUNT(*) FROM coexistence.chatbots WHERE organization_id IS NULL
    UNION ALL SELECT 'message_templates', COUNT(*) FROM coexistence.message_templates WHERE organization_id IS NULL
    UNION ALL SELECT 'broadcasts', COUNT(*) FROM coexistence.broadcasts WHERE organization_id IS NULL
    UNION ALL SELECT 'conversations', COUNT(*) FROM coexistence.conversations
  LOOP
    RAISE NOTICE 'backfill remainder: % NULL-org rows = %', r.t, r.n;
  END LOOP;
END $$;
