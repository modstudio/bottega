CREATE TABLE task_flow_with_taskless (
  record_id TEXT NOT NULL PRIMARY KEY,
  -- Keep a conflict target for the replayable 0198 backfill; SQLite uniqueness permits many NULLs.
  task_record_id TEXT UNIQUE,
  project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('open','done','dropped')),
  open_stage_cursor_record_id TEXT REFERENCES workflow_cursor(record_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  opening_machine_id TEXT,
  updated_machine_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
INSERT INTO task_flow_with_taskless
  (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
   opening_machine_id,updated_machine_id,revision)
SELECT record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
       opening_machine_id,updated_machine_id,revision
FROM task_flow;
DROP TABLE task_flow;
ALTER TABLE task_flow_with_taskless RENAME TO task_flow;
--> statement-breakpoint
CREATE UNIQUE INDEX task_flow_task
  ON task_flow(task_record_id) WHERE task_record_id IS NOT NULL;
CREATE INDEX task_flow_project ON task_flow(project_record_id);
CREATE INDEX task_flow_open_stage ON task_flow(open_stage_cursor_record_id);
