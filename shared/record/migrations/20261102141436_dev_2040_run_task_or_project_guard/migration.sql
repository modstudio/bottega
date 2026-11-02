ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  unlinked_run_count bigint;
BEGIN
  SELECT count(*) INTO unlinked_run_count
  FROM "run"
  WHERE NOT probe AND task_id IS NULL AND project_id IS NULL;

  IF unlinked_run_count > 0 THEN
    RAISE EXCEPTION 'run_task_or_project_unless_probe blocked by % violating rows',
      unlinked_run_count;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "run" FORCE ROW LEVEL SECURITY;
