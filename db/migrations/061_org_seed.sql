-- 061_org_seed.sql — seed one personal organization per existing user (APPROVED B1).
--
-- Ownership rule (defensible, NOT guessed): membership derives from the user's
-- own identity — every user becomes OWNER of exactly one workspace org named
-- for them. No row is assigned "because a single org exists": each membership
-- is anchored to its user_id.
-- Live-DB survey 2026-09-04: 1 user (id=1, admin) → seeds exactly 1 org + 1 membership.
-- Validation is fail-closed: any count mismatch raises EXCEPTION and the boot
-- runner aborts before serving traffic (no partial seeding).
-- Rollback: DELETE FROM coexistence.organization_members WHERE organization_id IN
--   (SELECT id FROM coexistence.organizations WHERE slug LIKE 'workspace-user-%'
--    AND NOT EXISTS (SELECT 1 FROM coexistence.whatsapp_accounts w WHERE w.organization_id = organizations.id)
--    AND NOT EXISTS (SELECT 1 FROM coexistence.organization_members m2 WHERE m2.organization_id = organizations.id AND m2.role <> 'owner'));
--   DELETE FROM coexistence.organizations WHERE slug LIKE 'workspace-user-%' AND <same guards>;
--   (guarded so seeded orgs that have since gained accounts/non-owner members are never removed).

DO $$
DECLARE
  v_users   INT;
  v_orgs    INT;
  v_members INT;
BEGIN
  SELECT COUNT(*) INTO v_users FROM coexistence.forgecrm_users;

  INSERT INTO coexistence.organizations (name, slug)
  SELECT u.username || '''s workspace', 'workspace-user-' || u.id::text
    FROM coexistence.forgecrm_users u
   WHERE NOT EXISTS (
     SELECT 1 FROM coexistence.organization_members m WHERE m.user_id = u.id
   )
  ON CONFLICT (slug) DO NOTHING;

  INSERT INTO coexistence.organization_members (organization_id, user_id, role)
  SELECT o.id, u.id, 'owner'
    FROM coexistence.forgecrm_users u
    JOIN coexistence.organizations o ON o.slug = 'workspace-user-' || u.id::text
   WHERE NOT EXISTS (
     SELECT 1 FROM coexistence.organization_members m
      WHERE m.user_id = u.id AND m.organization_id = o.id
   )
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- Fail-closed validation: every user must hold >= 1 membership now.
  SELECT COUNT(*) INTO v_orgs FROM coexistence.organizations WHERE slug LIKE 'workspace-user-%';
  SELECT COUNT(*) INTO v_members FROM coexistence.organization_members;
  IF EXISTS (SELECT 1 FROM coexistence.forgecrm_users u
              WHERE NOT EXISTS (SELECT 1 FROM coexistence.organization_members m WHERE m.user_id = u.id)) THEN
    RAISE EXCEPTION 'org seed: user(s) without membership remain — refusing partial seed';
  END IF;
  RAISE NOTICE 'org seed: users=%, seeded orgs=%, total memberships=%', v_users, v_orgs, v_members;
END $$;
