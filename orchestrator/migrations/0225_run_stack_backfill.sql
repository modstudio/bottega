-- BACKFILL
UPDATE run
SET stack=(
  SELECT project.stack
  FROM project
  WHERE project.record_id=run.project_record_id
)
WHERE (run.stack IS NULL OR TRIM(run.stack)='')
  AND EXISTS (
    SELECT 1
    FROM project
    WHERE project.record_id=run.project_record_id
      AND project.stack IS NOT NULL
      AND TRIM(project.stack)<>''
  );
-- /BACKFILL
