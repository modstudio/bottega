ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  unlinked_run_count bigint;
  unlinked_run_ids text;
BEGIN
  SELECT
    count(*),
    array_to_string((array_agg(id ORDER BY id))[1:10], ', ')
  INTO unlinked_run_count, unlinked_run_ids
  FROM "run"
  WHERE NOT probe AND task_id IS NULL AND project_id IS NULL;

  IF unlinked_run_count > 0 THEN
    RAISE EXCEPTION 'run_task_or_project_unless_probe blocked by % violating rows; offending run ids (up to 10): %; link each run to a task or a project, or mark it a probe, then rerun the migration',
      unlinked_run_count,
      unlinked_run_ids;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "run" FORCE ROW LEVEL SECURITY;
