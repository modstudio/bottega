ALTER TABLE task ADD COLUMN external_id TEXT;
ALTER TABLE task ADD COLUMN parent_record_id TEXT;
ALTER TABLE task_comment ADD COLUMN task_record_id TEXT;
ALTER TABLE task_document ADD COLUMN task_record_id TEXT;
ALTER TABLE task_status_event ADD COLUMN task_record_id TEXT;
ALTER TABLE note ADD COLUMN promoted_task_record_id TEXT;

CREATE UNIQUE INDEX task_project_external_id ON task(project, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX task_parent_record_id ON task(parent_record_id);
CREATE INDEX task_comment_task_record_id ON task_comment(task_record_id);
CREATE INDEX task_document_task_record_id ON task_document(task_record_id);
CREATE INDEX task_status_event_task_record_id ON task_status_event(task_record_id);
CREATE INDEX note_promoted_task_record_id ON note(promoted_task_record_id);

CREATE TABLE task_identity_claim (
  project TEXT NOT NULL,
  external_id TEXT NOT NULL,
  key TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE(project, external_id)
);
CREATE INDEX task_identity_claim_key ON task_identity_claim(key);

-- Preserve the key relationships while recording their stable ids.
-- BACKFILL
UPDATE task_comment
SET task_record_id = (SELECT record_id FROM task WHERE task.key = task_comment.task_key)
WHERE task_record_id IS NULL;
UPDATE task_document
SET task_record_id = (SELECT record_id FROM task WHERE task.key = task_document.task_key)
WHERE task_record_id IS NULL;
UPDATE task_status_event
SET task_record_id = (SELECT record_id FROM task WHERE task.key = task_status_event.task_key)
WHERE task_record_id IS NULL;
UPDATE task
SET parent_record_id = (SELECT parent.record_id FROM task parent WHERE parent.key = task.parent_key)
WHERE parent_record_id IS NULL AND parent_key IS NOT NULL;
UPDATE note
SET promoted_task_record_id = (SELECT record_id FROM task WHERE task.key = note.promoted_task)
WHERE promoted_task_record_id IS NULL AND promoted_task IS NOT NULL;
-- /BACKFILL
