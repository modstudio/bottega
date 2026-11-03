CREATE TABLE task_flow (
  record_id TEXT NOT NULL PRIMARY KEY,
  task_record_id TEXT NOT NULL UNIQUE,
  project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('open','done','dropped')),
  open_stage_cursor_record_id TEXT REFERENCES workflow_cursor(record_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
ALTER TABLE workflow_cursor
  ADD COLUMN task_flow_record_id TEXT REFERENCES task_flow(record_id);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_cursor_one_open_stage_per_flow
  ON workflow_cursor(task_flow_record_id)
  WHERE task_flow_record_id IS NOT NULL AND state NOT IN ('done','abandoned');
--> statement-breakpoint
CREATE INDEX task_flow_project ON task_flow(project_record_id);
CREATE INDEX task_flow_open_stage ON task_flow(open_stage_cursor_record_id);
CREATE INDEX workflow_cursor_task_flow ON workflow_cursor(task_flow_record_id);
--> statement-breakpoint
-- BACKFILL
-- newRecordId() is the runtime minter; these are migration-only random UUID-v4 values.
INSERT INTO task_flow(
  record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  task_record_id,project_record_id,'open',record_id,created_at,updated_at
FROM (
  SELECT *,ROW_NUMBER() OVER (PARTITION BY task_record_id ORDER BY number DESC) task_rank
  FROM workflow_cursor
  WHERE workflow_key<>'' AND task_record_id IS NOT NULL AND state NOT IN ('done','abandoned')
)
WHERE task_rank=1
ON CONFLICT(task_record_id) DO NOTHING;
--> statement-breakpoint
UPDATE workflow_cursor
SET task_flow_record_id=(
  SELECT flow.record_id FROM task_flow flow
  WHERE flow.open_stage_cursor_record_id=workflow_cursor.record_id
)
WHERE EXISTS (
  SELECT 1 FROM task_flow flow WHERE flow.open_stage_cursor_record_id=workflow_cursor.record_id
);
-- /BACKFILL
