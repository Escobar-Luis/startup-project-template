-- Row-level security and grants for the app role (AD-6). Applied after init.sql as the owner; idempotent.
-- The app role is created by scripts/provision-neon.mjs with NOBYPASSRLS and is not the table owner.

-- Tables the build agent adds later are reachable by the app role without editing this file.
-- A new table that holds visitor input still needs RLS and a policy below (AGENTS.md).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app;

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS submissions_insert_own ON submissions;
CREATE POLICY submissions_insert_own ON submissions FOR INSERT TO app
  WITH CHECK (visitor = current_setting('app.visitor', true));
DROP POLICY IF EXISTS submissions_select_own ON submissions;
CREATE POLICY submissions_select_own ON submissions FOR SELECT TO app
  USING (visitor = current_setting('app.visitor', true));

-- The template's own tables get exactly what the Worker needs.
REVOKE ALL ON demo_cache, llm_usage, submissions FROM app;
GRANT SELECT ON demo_cache TO app;
GRANT SELECT, INSERT, UPDATE ON llm_usage TO app;
GRANT SELECT, INSERT ON submissions TO app;
GRANT USAGE ON SEQUENCE submissions_id_seq TO app;
