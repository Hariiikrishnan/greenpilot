-- 062_org_columns.sql — stage-1 tenant columns (ADDITIVE ONLY, APPROVED B1).
--
-- Adds NULLABLE organization_id (NO foreign key yet — FKs land in 065 after
-- backfill validation) to every tenant-owned table. NULL = legacy/pre-tenancy
-- scope, readable only through dual-read service paths until backfilled.
-- No rows updated, no constraints changed, no data touched.
-- Tables deliberately EXCLUDED (global/reference — documented exceptions):
--   forgecrm_users, organizations, organization_members (identity root),
--   ai_models (global provider fallbacks), google_oauth_credentials (app-level
--   OAuth client), mcp_api_keys/mcp_settings (deployment-level connector config),
--   team_members/broadcast_variable_mapping (frozen legacy leftovers),
--   categories/tags/contact_field_definitions (shared taxonomy — per-org
--   duplication is staged; see backfill report), schema_migrations.
-- Rollback: one ALTER TABLE ... DROP COLUMN organization_id per table below.

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
      'ALTER TABLE coexistence.%I ADD COLUMN IF NOT EXISTS organization_id UUID',
      t
    );
  END LOOP;
END $$;
