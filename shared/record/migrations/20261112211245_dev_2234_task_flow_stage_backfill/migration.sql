ALTER TABLE "task_flow" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_flow_stage" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "seq" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $migration$
DECLARE
  missing_stage_id uuid;
BEGIN
  SELECT stage.id
  INTO missing_stage_id
  FROM task_flow_stage stage
  JOIN task_flow flow ON flow.id = stage.flow_record_id
  WHERE stage.project_id IS NULL
    AND flow.project_id IS NULL
  ORDER BY stage.created_at, stage.id
  LIMIT 1;

  IF missing_stage_id IS NOT NULL THEN
    RAISE EXCEPTION 'task-flow stage % has a flow with no project', missing_stage_id;
  END IF;
END
$migration$;
--> statement-breakpoint
UPDATE task_flow_stage stage
SET project_id = flow.project_id
FROM task_flow flow
WHERE stage.project_id IS NULL
  AND flow.id = stage.flow_record_id;
--> statement-breakpoint
WITH project_maximum AS (
  SELECT space_id, project_id, max(number) AS held_maximum
  FROM task_flow_stage
  GROUP BY space_id, project_id
),
numbered AS (
  SELECT
    stage.id,
    greatest(
      coalesce(sequence.next - 1, 0),
      coalesce(project_maximum.held_maximum, 0)
    ) + row_number() OVER (
      PARTITION BY stage.space_id, stage.project_id
      ORDER BY stage.created_at, stage.id
    ) AS assigned_number
  FROM task_flow_stage stage
  JOIN project_maximum
    ON project_maximum.space_id = stage.space_id
    AND project_maximum.project_id = stage.project_id
  LEFT JOIN seq sequence
    ON sequence.space_id = stage.space_id
    AND sequence.project_id = stage.project_id
    AND sequence.name = 'task_flow_stage'
  WHERE stage.number IS NULL
)
UPDATE task_flow_stage stage
SET number = numbered.assigned_number
FROM numbered
WHERE stage.id = numbered.id;
--> statement-breakpoint
INSERT INTO seq (id, space_id, project_id, name, next)
SELECT
  gen_random_uuid(),
  space_id,
  project_id,
  'task_flow_stage',
  max(number) + 1
FROM task_flow_stage
GROUP BY space_id, project_id
ON CONFLICT (space_id, project_id, name) DO UPDATE
SET next = greatest(seq.next, excluded.next);
--> statement-breakpoint
ALTER TABLE "seq" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_flow_stage" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_flow" FORCE ROW LEVEL SECURITY;
