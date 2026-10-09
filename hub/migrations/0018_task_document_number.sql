PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
ALTER TABLE task ADD COLUMN next_document_number INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
-- newRecordId() is the runtime minter; this is a migration-only random UUID-v4 value.
UPDATE task_document
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
CREATE TABLE task_document_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  task_key TEXT NOT NULL,
  task_record_id TEXT NOT NULL REFERENCES task(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  number INTEGER NOT NULL,
  role TEXT CHECK (role IN ('handoff')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_record_id, number)
);
--> statement-breakpoint
INSERT INTO task_document_uuid
  (record_id,task_key,task_record_id,number,role,title,body,version,created_at,updated_at)
SELECT record_id,task_key,task_record_id,
  row_number() OVER (PARTITION BY task_record_id ORDER BY created_at,record_id),
  role,title,body,version,created_at,updated_at
FROM task_document;
--> statement-breakpoint
UPDATE task SET next_document_number = COALESCE(
  (SELECT MAX(number) + 1 FROM task_document_uuid WHERE task_record_id = task.record_id), 1
);
--> statement-breakpoint
DROP TABLE task_document;
--> statement-breakpoint
ALTER TABLE task_document_uuid RENAME TO task_document;
--> statement-breakpoint
CREATE UNIQUE INDEX task_document_one_role ON task_document(task_record_id, role) WHERE role IS NOT NULL;
CREATE INDEX task_document_task ON task_document(task_record_id, number);
CREATE INDEX task_document_task_record_id ON task_document(task_record_id);
