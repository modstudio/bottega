PRAGMA defer_foreign_keys = ON;
CREATE TEMP TABLE task_flow_copy AS SELECT * FROM task_flow;
DROP TABLE task_flow;
CREATE TABLE task_flow (
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
INSERT INTO task_flow
  (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
   opening_machine_id,updated_machine_id,revision)
SELECT record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
       opening_machine_id,updated_machine_id,revision
FROM task_flow_copy;
DROP TABLE task_flow_copy;
--> statement-breakpoint
CREATE INDEX task_flow_project ON task_flow(project_record_id);
CREATE INDEX task_flow_open_stage ON task_flow(open_stage_cursor_record_id);
