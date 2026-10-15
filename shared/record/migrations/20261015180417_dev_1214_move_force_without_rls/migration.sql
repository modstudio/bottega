-- Tables without row security, such as public_doc_space, still move with the
-- project. Re-forcing RLS is skipped when the table has none.
DO $migration$
DECLARE
  definition text;
  force_loop text := $fragment$EXECUTE format(
        'UPDATE %I t SET space_id=$1 FROM move_row mr WHERE mr.table_name=%L AND t.ctid=mr.locator',
        candidate.name, candidate.name
      ) USING destination_id;
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', candidate.name);$fragment$;
  guarded_loop text := $fragment$EXECUTE format(
        'UPDATE %I t SET space_id=$1 FROM move_row mr WHERE mr.table_name=%L AND t.ctid=mr.locator',
        candidate.name, candidate.name
      ) USING destination_id;
      IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=candidate.name AND c.relrowsecurity
      ) THEN
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', candidate.name);
      END IF;$fragment$;
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
  INTO definition;
  IF length(definition) - length(replace(definition, force_loop, '')) <> length(force_loop) THEN
    RAISE EXCEPTION 'record_move_project_space definition does not match the expected predecessor';
  END IF;
  definition := replace(definition, force_loop, guarded_loop);
  EXECUTE definition;
END
$migration$;
