CREATE OR REPLACE FUNCTION link_hosted_task_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.deleted_at IS NULL THEN
    UPDATE question
    SET workflow_task_id = NEW.id
    WHERE space_id = NEW.space_id
      AND workflow_task_id IS NULL
      AND workflow_key = NEW.key;

    UPDATE operator_waiting_email
    SET task_id = NEW.id
    WHERE space_id = NEW.space_id
      AND task_id IS NULL
      AND task_key = NEW.key;

    UPDATE run
    SET task_id = NEW.id
    WHERE space_id = NEW.space_id
      AND task_id IS NULL
      AND task_key = NEW.key;

    UPDATE hub_task_comment
    SET task_id = NEW.id
    WHERE space_id = NEW.space_id
      AND task_id IS NULL
      AND task_key = NEW.key;

    UPDATE hub_task_document
    SET task_id = NEW.id
    WHERE space_id = NEW.space_id
      AND task_id IS NULL
      AND task_key = NEW.key;

    UPDATE hub_task_status_event
    SET task_id = NEW.id
    WHERE space_id = NEW.space_id
      AND task_id IS NULL
      AND task_key = NEW.key;

    UPDATE hub_task
    SET parent_id = NEW.id
    WHERE space_id = NEW.space_id
      AND parent_id IS NULL
      AND parent_key = NEW.key
      AND id <> NEW.id;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER TABLE "hub_task" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub_task_comment" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub_task_document" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub_task_status_event" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
WITH matches AS (
  SELECT child.id, min(task.id::text)::uuid AS task_id
  FROM hub_task_comment AS child
  JOIN hub_task AS task
    ON task.space_id = child.space_id
   AND task.key = child.task_key
   AND task.deleted_at IS NULL
  WHERE child.task_id IS NULL
  GROUP BY child.id
  HAVING count(*) = 1
)
UPDATE hub_task_comment AS child
SET task_id = matches.task_id
FROM matches
WHERE child.id = matches.id;
--> statement-breakpoint
WITH matches AS (
  SELECT child.id, min(task.id::text)::uuid AS task_id
  FROM hub_task_document AS child
  JOIN hub_task AS task
    ON task.space_id = child.space_id
   AND task.key = child.task_key
   AND task.deleted_at IS NULL
  WHERE child.task_id IS NULL
  GROUP BY child.id
  HAVING count(*) = 1
)
UPDATE hub_task_document AS child
SET task_id = matches.task_id
FROM matches
WHERE child.id = matches.id;
--> statement-breakpoint
WITH matches AS (
  SELECT child.id, min(task.id::text)::uuid AS task_id
  FROM hub_task_status_event AS child
  JOIN hub_task AS task
    ON task.space_id = child.space_id
   AND task.key = child.task_key
   AND task.deleted_at IS NULL
  WHERE child.task_id IS NULL
  GROUP BY child.id
  HAVING count(*) = 1
)
UPDATE hub_task_status_event AS child
SET task_id = matches.task_id
FROM matches
WHERE child.id = matches.id;
--> statement-breakpoint
WITH matches AS (
  SELECT child.id, min(parent.id::text)::uuid AS parent_id
  FROM hub_task AS child
  JOIN hub_task AS parent
    ON parent.space_id = child.space_id
   AND parent.key = child.parent_key
   AND parent.deleted_at IS NULL
   AND parent.id <> child.id
  WHERE child.parent_id IS NULL
    AND child.parent_key IS NOT NULL
  GROUP BY child.id
  HAVING count(*) = 1
)
UPDATE hub_task AS child
SET parent_id = matches.parent_id
FROM matches
WHERE child.id = matches.id;
--> statement-breakpoint
ALTER TABLE "hub_task" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub_task_comment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub_task_document" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub_task_status_event" FORCE ROW LEVEL SECURITY;
