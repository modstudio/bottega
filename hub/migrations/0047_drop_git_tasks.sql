CREATE TEMP TABLE git_task_delete_guard (detail TEXT);
--> statement-breakpoint
CREATE TEMP TRIGGER git_task_delete_refusal
BEFORE INSERT ON git_task_delete_guard
WHEN NEW.detail IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, NEW.detail);
END;
--> statement-breakpoint
INSERT INTO git_task_delete_guard(detail)
SELECT 'git task rows have cascade dependents: ' || group_concat(dependent, ', ') ||
  '; preserve or reassign these rows before running bottega machine migrate'
FROM (
  SELECT 'task_comment:' || c.record_id AS dependent
  FROM task_comment c JOIN task t ON t.record_id=c.task_record_id WHERE t.source='git'
  UNION ALL
  SELECT 'task_document:' || d.record_id
  FROM task_document d JOIN task t ON t.record_id=d.task_record_id WHERE t.source='git'
)
HAVING count(*) > 0;
--> statement-breakpoint
DROP TRIGGER git_task_delete_refusal;
DROP TABLE git_task_delete_guard;
--> statement-breakpoint
DROP TRIGGER interval_require_task_or_project_update;
--> statement-breakpoint
UPDATE task SET parent_record_id=NULL
WHERE parent_record_id IN (SELECT record_id FROM task WHERE source='git');
UPDATE note SET promoted_task_record_id=NULL
WHERE promoted_task_record_id IN (SELECT record_id FROM task WHERE source='git');
UPDATE interval SET task_record_id=NULL
WHERE task_record_id IN (SELECT record_id FROM task WHERE source='git');
UPDATE question SET task_record_id=NULL
WHERE task_record_id IN (SELECT record_id FROM task WHERE source='git');
UPDATE question SET workflow_task_record_id=NULL
WHERE workflow_task_record_id IN (SELECT record_id FROM task WHERE source='git');
UPDATE commit_key SET task_record_id=NULL
WHERE task_record_id IN (SELECT record_id FROM task WHERE source='git');
DELETE FROM task_status_event
WHERE task_record_id IN (SELECT record_id FROM task WHERE source='git');
DELETE FROM task WHERE source='git';
--> statement-breakpoint
CREATE TRIGGER interval_require_task_or_project_update
BEFORE UPDATE OF task_record_id, project_record_id ON interval
WHEN NEW.task_record_id IS NULL AND NEW.project_record_id IS NULL
  AND (OLD.task_record_id IS NOT NULL OR OLD.project_record_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'an interval must reference a task or a project; register the project or use a task key that resolves to exactly one task');
END;
--> statement-breakpoint
CREATE TABLE task_tracker_only (
  record_id TEXT PRIMARY KEY NOT NULL,
  external_id TEXT,
  key TEXT NOT NULL,
  project TEXT NOT NULL,
  title TEXT,
  status TEXT,
  status_category TEXT CHECK (status_category IN ('open','active','review','done','dropped')),
  opened_at TEXT,
  closed_at TEXT,
  updated_at TEXT,
  source TEXT NOT NULL CHECK (source IN ('mcp','local')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  parent_key TEXT,
  parent_record_id TEXT REFERENCES task_tracker_only(record_id) ON UPDATE CASCADE ON DELETE SET NULL,
  body TEXT,
  assignee TEXT,
  next_document_number INTEGER NOT NULL DEFAULT 1,
  project_record_id TEXT,
  UNIQUE(project, key)
);
--> statement-breakpoint
INSERT INTO task_tracker_only
  (record_id,external_id,key,project,title,status,status_category,opened_at,closed_at,updated_at,
   source,first_seen,last_seen,parent_key,parent_record_id,body,assignee,next_document_number,project_record_id)
SELECT record_id,external_id,key,project,title,status,status_category,opened_at,closed_at,updated_at,
  source,first_seen,last_seen,parent_key,parent_record_id,body,assignee,next_document_number,project_record_id
FROM task;
--> statement-breakpoint
DROP TABLE task;
ALTER TABLE task_tracker_only RENAME TO task;
--> statement-breakpoint
CREATE UNIQUE INDEX task_project_external_id ON task(project, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX task_parent ON task(parent_key);
CREATE INDEX task_parent_record_id ON task(parent_record_id);
CREATE INDEX task_project ON task(project, status_category);
--> statement-breakpoint
CREATE TRIGGER task_link_unlinked_intervals_insert
AFTER INSERT ON task
WHEN (SELECT COUNT(*) FROM task WHERE key=NEW.key)=1
BEGIN
  UPDATE interval SET task_record_id=NEW.record_id
  WHERE task_key=NEW.key AND task_record_id IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER task_link_unlinked_questions_insert
AFTER INSERT ON task
WHEN (SELECT COUNT(*) FROM task WHERE key=NEW.key)=1
BEGIN
  UPDATE question SET task_record_id=NEW.record_id
  WHERE task_key=NEW.key AND task_record_id IS NULL;
  UPDATE question SET workflow_task_record_id=NEW.record_id
  WHERE workflow_key=NEW.key AND workflow_task_record_id IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER task_link_unlinked_commit_keys_insert
AFTER INSERT ON task
WHEN (SELECT COUNT(*) FROM task WHERE key=NEW.key)=1
BEGIN
  UPDATE commit_key SET task_record_id=NEW.record_id
  WHERE task_key=NEW.key AND task_record_id IS NULL;
END;
