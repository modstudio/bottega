PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
-- newRecordId() is the runtime minter; these are migration-only random UUID-v4 values.
UPDATE task_comment
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
UPDATE task_status_event
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
UPDATE send
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
CREATE TABLE task_comment_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  task_key TEXT NOT NULL,
  task_record_id TEXT NOT NULL REFERENCES task(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE task_status_event_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  task_key TEXT NOT NULL,
  task_record_id TEXT NOT NULL REFERENCES task(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  at TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL
);
CREATE TABLE send_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  at TEXT NOT NULL,
  window TEXT NOT NULL,
  recipients TEXT NOT NULL,
  projects TEXT NOT NULL,
  items INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','skipped','failed')),
  error TEXT,
  test INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO task_comment_uuid(record_id,task_key,task_record_id,body,created_at)
SELECT record_id,task_key,task_record_id,body,created_at FROM task_comment;
INSERT INTO task_status_event_uuid(record_id,task_key,task_record_id,at,from_status,to_status)
SELECT record_id,task_key,task_record_id,at,from_status,to_status FROM task_status_event;
INSERT INTO send_uuid(record_id,at,window,recipients,projects,items,status,error,test)
SELECT record_id,at,window,recipients,projects,items,status,error,test FROM send;
--> statement-breakpoint
DROP TABLE task_comment;
DROP TABLE task_status_event;
DROP TABLE send;
--> statement-breakpoint
ALTER TABLE task_comment_uuid RENAME TO task_comment;
ALTER TABLE task_status_event_uuid RENAME TO task_status_event;
ALTER TABLE send_uuid RENAME TO send;
--> statement-breakpoint
CREATE INDEX task_comment_task ON task_comment(task_key, created_at);
CREATE INDEX task_comment_task_record_id ON task_comment(task_record_id);
CREATE INDEX task_status_event_task_record_id ON task_status_event(task_record_id);
CREATE INDEX tse_at ON task_status_event(at);
CREATE UNIQUE INDEX tse_one_per_change ON task_status_event(task_record_id, to_status, at);
