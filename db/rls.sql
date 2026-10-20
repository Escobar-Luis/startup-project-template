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

-- Per-visitor limiter (AD-7 fallback): the app role reads and bumps only the current visitor's rows
-- (app.visitor set in the same transaction), and may delete any visitor's windows once they are an hour old.
ALTER TABLE visitor_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitor_hits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visitor_hits_select ON visitor_hits;
-- DELETE ... WHERE also checks SELECT policies, so stale windows are readable too (a hashed key and a count).
CREATE POLICY visitor_hits_select ON visitor_hits FOR SELECT TO app
  USING (visitor = current_setting('app.visitor', true) OR window_start < now() - interval '1 hour');
DROP POLICY IF EXISTS visitor_hits_insert_own ON visitor_hits;
CREATE POLICY visitor_hits_insert_own ON visitor_hits FOR INSERT TO app
  WITH CHECK (visitor = current_setting('app.visitor', true));
DROP POLICY IF EXISTS visitor_hits_update_own ON visitor_hits;
CREATE POLICY visitor_hits_update_own ON visitor_hits FOR UPDATE TO app
  USING (visitor = current_setting('app.visitor', true))
  WITH CHECK (visitor = current_setting('app.visitor', true));
DROP POLICY IF EXISTS visitor_hits_delete_old ON visitor_hits;
CREATE POLICY visitor_hits_delete_old ON visitor_hits FOR DELETE TO app
  USING (window_start < now() - interval '1 hour');

-- The template's own tables get exactly what the Worker needs.
REVOKE ALL ON demo_cache, llm_usage, submissions, visitor_hits FROM app;
GRANT SELECT ON demo_cache TO app;
GRANT SELECT, INSERT, UPDATE ON llm_usage TO app;
GRANT SELECT, INSERT ON submissions TO app;
GRANT USAGE ON SEQUENCE submissions_id_seq TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON visitor_hits TO app;
