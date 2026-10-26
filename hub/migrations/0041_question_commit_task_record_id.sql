ALTER TABLE question ADD COLUMN task_record_id TEXT
  REFERENCES task(record_id) ON UPDATE CASCADE ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE question ADD COLUMN workflow_task_record_id TEXT
  REFERENCES task(record_id) ON UPDATE CASCADE ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE commit_key ADD COLUMN task_record_id TEXT
  REFERENCES task(record_id) ON UPDATE CASCADE ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX question_task_record_id ON question(task_record_id);
--> statement-breakpoint
CREATE INDEX question_workflow_task_record_id ON question(workflow_task_record_id);
--> statement-breakpoint
CREATE INDEX commit_key_task_record_id ON commit_key(task_record_id);
--> statement-breakpoint
CREATE INDEX question_task_key ON question(task_key);
--> statement-breakpoint
CREATE INDEX question_workflow_key ON question(workflow_key);
--> statement-breakpoint
CREATE INDEX commit_key_task_key ON commit_key(task_key);
--> statement-breakpoint
-- BACKFILL
UPDATE question
SET task_record_id = (
  SELECT MIN(t.record_id) FROM task t WHERE t.key=question.task_key
)
WHERE task_key IS NOT NULL
  AND (SELECT COUNT(*) FROM task t WHERE t.key=question.task_key)=1;

UPDATE question
SET workflow_task_record_id = (
  SELECT MIN(t.record_id) FROM task t WHERE t.key=question.workflow_key
)
WHERE workflow_key IS NOT NULL
  AND (SELECT COUNT(*) FROM task t WHERE t.key=question.workflow_key)=1;

UPDATE commit_key
SET task_record_id = (
  SELECT MIN(t.record_id) FROM task t WHERE t.key=commit_key.task_key
)
WHERE task_key IS NOT NULL
  AND (SELECT COUNT(*) FROM task t WHERE t.key=commit_key.task_key)=1;
-- /BACKFILL
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
