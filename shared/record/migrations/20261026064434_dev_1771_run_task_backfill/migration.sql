ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub_task" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "run" AS run_row SET task_id = task.id
FROM hub_task AS task
WHERE run_row.task_id IS NULL
  AND run_row.task_key IS NOT NULL
  AND task.space_id = run_row.space_id
  AND task.key = run_row.task_key;
--> statement-breakpoint
DO $$
DECLARE
  unmatched_run bigint;
BEGIN
  SELECT count(*) INTO unmatched_run
  FROM "run"
  WHERE task_key IS NOT NULL AND task_id IS NULL;
  RAISE NOTICE 'DEV-1771 hosted runs with task_key and no task_id: %', unmatched_run;
END $$;
--> statement-breakpoint
ALTER TABLE "run" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub_task" FORCE ROW LEVEL SECURITY;
