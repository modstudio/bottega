PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
UPDATE task
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
UPDATE task_comment
SET task_record_id = (SELECT record_id FROM task WHERE task.key = task_comment.task_key)
WHERE task_record_id IS NULL;
--> statement-breakpoint
UPDATE task_document
SET task_record_id = (SELECT record_id FROM task WHERE task.key = task_document.task_key)
WHERE task_record_id IS NULL;
--> statement-breakpoint
UPDATE task_status_event
SET task_record_id = (SELECT record_id FROM task WHERE task.key = task_status_event.task_key)
WHERE task_record_id IS NULL;
--> statement-breakpoint
UPDATE task
SET parent_record_id = (SELECT parent.record_id FROM task parent WHERE parent.key = task.parent_key)
WHERE parent_record_id IS NULL AND parent_key IS NOT NULL;
--> statement-breakpoint
UPDATE note
SET promoted_task_record_id = (SELECT record_id FROM task WHERE task.key = note.promoted_task)
WHERE promoted_task_record_id IS NULL AND promoted_task IS NOT NULL;
--> statement-breakpoint
CREATE TEMP TABLE task_identity_migration_guard (detail TEXT);
--> statement-breakpoint
CREATE TEMP TRIGGER task_identity_migration_refusal
BEFORE INSERT ON task_identity_migration_guard
WHEN NEW.detail IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, NEW.detail);
END;
--> statement-breakpoint
INSERT INTO task_identity_migration_guard(detail)
SELECT 'unresolved task_comment rows: ' || group_concat(id || ':' || task_key, ', ')
FROM task_comment WHERE task_record_id IS NULL HAVING count(*) > 0;
--> statement-breakpoint
INSERT INTO task_identity_migration_guard(detail)
SELECT 'unresolved task_document rows: ' || group_concat(id || ':' || task_key, ', ')
FROM task_document WHERE task_record_id IS NULL HAVING count(*) > 0;
--> statement-breakpoint
INSERT INTO task_identity_migration_guard(detail)
SELECT 'unresolved task_status_event rows: ' || group_concat(id || ':' || task_key, ', ')
FROM task_status_event WHERE task_record_id IS NULL HAVING count(*) > 0;
--> statement-breakpoint
DROP TRIGGER task_identity_migration_refusal;
--> statement-breakpoint
DROP TABLE task_identity_migration_guard;
--> statement-breakpoint
CREATE TABLE task_new (
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
  source TEXT NOT NULL CHECK (source IN ('mcp','git','local')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  parent_key TEXT,
  parent_record_id TEXT REFERENCES task_new(record_id) ON UPDATE CASCADE ON DELETE SET NULL,
  body TEXT,
  assignee TEXT,
  UNIQUE(project, key)
);
--> statement-breakpoint
INSERT INTO task_new
SELECT record_id,external_id,key,project,title,status,status_category,opened_at,closed_at,updated_at,
  source,first_seen,last_seen,parent_key,parent_record_id,body,assignee FROM task;
--> statement-breakpoint
CREATE TABLE task_comment_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT,
  task_key TEXT NOT NULL,
  task_record_id TEXT NOT NULL REFERENCES task_new(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO task_comment_new(id,record_id,task_key,task_record_id,body,created_at)
SELECT id,record_id,task_key,task_record_id,body,created_at FROM task_comment;
--> statement-breakpoint
CREATE TABLE task_document_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT,
  task_key TEXT NOT NULL,
  task_record_id TEXT NOT NULL REFERENCES task_new(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  role TEXT CHECK (role IN ('handoff')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO task_document_new(id,record_id,task_key,task_record_id,role,title,body,version,created_at,updated_at)
SELECT id,record_id,task_key,task_record_id,role,title,body,version,created_at,updated_at FROM task_document;
--> statement-breakpoint
CREATE TABLE task_status_event_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT,
  task_key TEXT NOT NULL,
  task_record_id TEXT NOT NULL REFERENCES task_new(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  at TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO task_status_event_new(id,record_id,task_key,task_record_id,at,from_status,to_status)
SELECT id,record_id,task_key,task_record_id,at,from_status,to_status FROM task_status_event;
--> statement-breakpoint
CREATE TABLE note_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT,
  project TEXT NOT NULL,
  text TEXT NOT NULL,
  area TEXT,
  anchors TEXT NOT NULL,
  sightings INTEGER NOT NULL DEFAULT 1 CHECK (sightings > 0),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  stale_at TEXT,
  stale_reason TEXT,
  promoted_task TEXT,
  promoted_task_record_id TEXT REFERENCES task_new(record_id) ON UPDATE CASCADE ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO note_new
SELECT id,record_id,project,text,area,anchors,sightings,created_at,last_seen_at,stale_at,stale_reason,
  promoted_task,promoted_task_record_id FROM note;
--> statement-breakpoint
CREATE TABLE note_acknowledgement_new (
  note_id INTEGER NOT NULL REFERENCES note_new(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  sightings INTEGER NOT NULL CHECK (sightings > 0),
  record_id TEXT,
  PRIMARY KEY (note_id, session_id)
);
--> statement-breakpoint
INSERT INTO note_acknowledgement_new(note_id,session_id,acknowledged_at,sightings,record_id)
SELECT note_id,session_id,acknowledged_at,sightings,record_id FROM note_acknowledgement;
--> statement-breakpoint
DROP TABLE task_comment;
DROP TABLE task_document;
DROP TABLE task_status_event;
DROP TABLE note_acknowledgement;
DROP TABLE note;
DROP TABLE task;
--> statement-breakpoint
ALTER TABLE task_new RENAME TO task;
ALTER TABLE task_comment_new RENAME TO task_comment;
ALTER TABLE task_document_new RENAME TO task_document;
ALTER TABLE task_status_event_new RENAME TO task_status_event;
ALTER TABLE note_new RENAME TO note;
ALTER TABLE note_acknowledgement_new RENAME TO note_acknowledgement;
--> statement-breakpoint
CREATE UNIQUE INDEX task_project_external_id ON task(project, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX task_parent ON task(parent_key);
CREATE INDEX task_parent_record_id ON task(parent_record_id);
CREATE INDEX task_project ON task(project, status_category);
CREATE UNIQUE INDEX task_comment_record_id ON task_comment(record_id) WHERE record_id IS NOT NULL;
CREATE INDEX task_comment_task ON task_comment(task_key, created_at);
CREATE INDEX task_comment_task_record_id ON task_comment(task_record_id);
CREATE UNIQUE INDEX task_document_record_id ON task_document(record_id) WHERE record_id IS NOT NULL;
CREATE UNIQUE INDEX task_document_one_role ON task_document(task_record_id, role) WHERE role IS NOT NULL;
CREATE INDEX task_document_task ON task_document(task_record_id, created_at, id);
CREATE INDEX task_document_task_record_id ON task_document(task_record_id);
CREATE UNIQUE INDEX task_status_event_record_id ON task_status_event(record_id) WHERE record_id IS NOT NULL;
CREATE INDEX task_status_event_task_record_id ON task_status_event(task_record_id);
CREATE INDEX tse_at ON task_status_event(at);
CREATE UNIQUE INDEX tse_one_per_change ON task_status_event(task_record_id, to_status, at);
CREATE UNIQUE INDEX note_record_id ON note(record_id) WHERE record_id IS NOT NULL;
CREATE INDEX note_project_seen ON note(project, last_seen_at DESC);
CREATE INDEX note_promoted_task_record_id ON note(promoted_task_record_id);
CREATE UNIQUE INDEX note_acknowledgement_record_id ON note_acknowledgement(record_id) WHERE record_id IS NOT NULL;
CREATE INDEX note_acknowledgement_session ON note_acknowledgement(session_id, acknowledged_at DESC);
