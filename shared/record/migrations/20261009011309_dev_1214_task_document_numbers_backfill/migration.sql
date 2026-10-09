ALTER TABLE hub_task_document NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
WITH numbered AS (
  SELECT id,
    row_number() OVER (PARTITION BY task_id ORDER BY created_at,id)::integer AS number
  FROM hub_task_document
  WHERE deleted_at IS NULL
)
UPDATE hub_task_document AS document
SET number = numbered.number
FROM numbered
WHERE document.id = numbered.id;
--> statement-breakpoint
UPDATE hub_task AS task
SET next_document_number = COALESCE((
  SELECT MAX(document.number) + 1
  FROM hub_task_document AS document
  WHERE document.task_id = task.id AND document.deleted_at IS NULL
), 1);
--> statement-breakpoint
ALTER TABLE hub_task_document FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
