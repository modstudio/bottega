ALTER TABLE "hub_task" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "question" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "operator_waiting_email" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE question AS question_row
SET workflow_task_id = task.id
FROM hub_task AS task
WHERE question_row.workflow_task_id IS NULL
  AND question_row.workflow_key IS NOT NULL
  AND task.space_id = question_row.space_id
  AND task.key = question_row.workflow_key
  AND task.deleted_at IS NULL;
--> statement-breakpoint
UPDATE operator_waiting_email AS email_row
SET task_id = task.id
FROM hub_task AS task
WHERE email_row.task_id IS NULL
  AND email_row.task_key IS NOT NULL
  AND task.space_id = email_row.space_id
  AND task.key = email_row.task_key
  AND task.deleted_at IS NULL;
--> statement-breakpoint
UPDATE run AS run_row
SET task_id = task.id
FROM hub_task AS task
WHERE run_row.task_id IS NULL
  AND run_row.task_key IS NOT NULL
  AND task.space_id = run_row.space_id
  AND task.key = run_row.task_key
  AND task.deleted_at IS NULL;
--> statement-breakpoint
DO $$
DECLARE
  unmatched_question bigint;
  unmatched_operator_waiting_email bigint;
  unmatched_run bigint;
BEGIN
  SELECT count(*) INTO unmatched_question
  FROM question
  WHERE workflow_key IS NOT NULL AND workflow_task_id IS NULL;

  SELECT count(*) INTO unmatched_operator_waiting_email
  FROM operator_waiting_email
  WHERE task_key IS NOT NULL AND task_id IS NULL;

  SELECT count(*) INTO unmatched_run
  FROM run
  WHERE task_key IS NOT NULL AND task_id IS NULL;

  RAISE NOTICE 'DEV-1773 unmatched hosted task links: question=%, operator_waiting_email=%, run=%',
    unmatched_question, unmatched_operator_waiting_email, unmatched_run;
END $$;
--> statement-breakpoint
ALTER TABLE "hub_task" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "question" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "operator_waiting_email" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "run" FORCE ROW LEVEL SECURITY;
