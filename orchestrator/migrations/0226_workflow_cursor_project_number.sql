CREATE TEMP TABLE workflow_obligation_project_number_snapshot AS SELECT * FROM workflow_obligation;
CREATE TEMP TABLE workflow_step_text_project_number_snapshot AS SELECT * FROM workflow_step_text;
CREATE TEMP TABLE workflow_text_copy_project_number_snapshot AS SELECT * FROM workflow_text_copy;
DELETE FROM workflow_text_copy;
DELETE FROM workflow_step_text;
DELETE FROM workflow_obligation;
--> statement-breakpoint
CREATE TABLE workflow_cursor_project_number (
  record_id TEXT NOT NULL PRIMARY KEY, number INTEGER NOT NULL,
  project TEXT NOT NULL, project_record_id TEXT REFERENCES project(record_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  workflow_slug TEXT NOT NULL, mode_slug TEXT NOT NULL, workflow_key TEXT NOT NULL DEFAULT '',
  instance_id TEXT NOT NULL, session_id TEXT,
  workflow_version_record_id TEXT NOT NULL REFERENCES workflow_version(record_id) ON UPDATE CASCADE,
  catalogue_version_record_id TEXT NOT NULL REFERENCES step_catalogue_version(record_id) ON UPDATE CASCADE,
  args TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal>=0), step_slug TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','awaiting-ruling','done','abandoned')),
  closed TEXT NOT NULL DEFAULT '[]', question TEXT, total_steps INTEGER NOT NULL CHECK(total_steps>0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, autonomy TEXT,
  enforcement TEXT NOT NULL DEFAULT 'note-only' CHECK(enforcement IN ('note-only','floors')),
  task_record_id TEXT, task_flow_record_id TEXT REFERENCES task_flow(record_id),
  opened_machine_id TEXT, taken_over_from_machine_id TEXT, last_advanced_machine_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_record_id,workflow_slug,mode_slug,workflow_key,instance_id)
);
INSERT INTO workflow_cursor_project_number
SELECT record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
       session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,
       closed,question,total_steps,created_at,updated_at,autonomy,enforcement,task_record_id,
       task_flow_record_id,opened_machine_id,taken_over_from_machine_id,last_advanced_machine_id,revision
FROM workflow_cursor;
DROP TABLE workflow_cursor;
ALTER TABLE workflow_cursor_project_number RENAME TO workflow_cursor;
INSERT INTO workflow_obligation SELECT * FROM workflow_obligation_project_number_snapshot;
INSERT INTO workflow_step_text SELECT * FROM workflow_step_text_project_number_snapshot;
INSERT INTO workflow_text_copy SELECT * FROM workflow_text_copy_project_number_snapshot;
DROP TABLE workflow_obligation_project_number_snapshot;
DROP TABLE workflow_step_text_project_number_snapshot;
DROP TABLE workflow_text_copy_project_number_snapshot;
--> statement-breakpoint
WITH ranked AS (
  SELECT record_id,
         ROW_NUMBER() OVER (PARTITION BY project_record_id ORDER BY created_at,number) next_number
  FROM workflow_cursor
)
UPDATE workflow_cursor
SET number=-(SELECT next_number FROM ranked WHERE ranked.record_id=workflow_cursor.record_id);
UPDATE workflow_cursor SET number=-number;
--> statement-breakpoint
CREATE INDEX workflow_cursor_session ON workflow_cursor(session_id,state);
CREATE INDEX workflow_cursor_workflow_version ON workflow_cursor(workflow_version_record_id);
CREATE INDEX workflow_cursor_catalogue_version ON workflow_cursor(catalogue_version_record_id);
CREATE INDEX workflow_cursor_project ON workflow_cursor(project_record_id,state);
CREATE INDEX workflow_cursor_task_record_id ON workflow_cursor(task_record_id);
CREATE UNIQUE INDEX workflow_cursor_one_open_stage_per_flow
  ON workflow_cursor(task_flow_record_id)
  WHERE task_flow_record_id IS NOT NULL AND state NOT IN ('done','abandoned');
CREATE INDEX workflow_cursor_task_flow ON workflow_cursor(task_flow_record_id);
CREATE UNIQUE INDEX workflow_cursor_project_number
  ON workflow_cursor(project_record_id,number);
