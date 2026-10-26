ALTER TABLE interval ADD COLUMN task_record_id TEXT
  REFERENCES task(record_id) ON UPDATE CASCADE ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX interval_task_record_id ON interval(task_record_id);
--> statement-breakpoint
-- BACKFILL
UPDATE interval
SET task_record_id = (
  SELECT MIN(t.record_id) FROM task t WHERE t.key=interval.task_key
)
WHERE task_key IS NOT NULL
  AND (SELECT COUNT(*) FROM task t WHERE t.key=interval.task_key)=1;
-- /BACKFILL
CREATE TRIGGER interval_require_task_or_project_insert
BEFORE INSERT ON interval
WHEN NEW.task_record_id IS NULL AND NEW.project_record_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'an interval must reference a task or a project; register the project or use a task key that resolves to exactly one task');
END;
--> statement-breakpoint
CREATE TRIGGER interval_require_task_or_project_update
BEFORE UPDATE OF task_record_id, project_record_id ON interval
WHEN NEW.task_record_id IS NULL AND NEW.project_record_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'an interval must reference a task or a project; register the project or use a task key that resolves to exactly one task');
END;
--> statement-breakpoint
CREATE TRIGGER task_link_unlinked_intervals_insert
AFTER INSERT ON task
WHEN (SELECT COUNT(*) FROM task WHERE key=NEW.key)=1
BEGIN
  UPDATE interval SET task_record_id=NEW.record_id
  WHERE task_key=NEW.key AND task_record_id IS NULL;
END;
--> statement-breakpoint
DROP TRIGGER interval_hosted_update;
--> statement-breakpoint
CREATE TRIGGER interval_hosted_update AFTER UPDATE ON interval
WHEN OLD.task_key IS NOT NEW.task_key OR OLD.task_record_id IS NOT NEW.task_record_id
  OR OLD.project IS NOT NEW.project OR OLD.project_record_id IS NOT NEW.project_record_id
  OR OLD.source IS NOT NEW.source OR OLD.agent IS NOT NEW.agent OR OLD.job IS NOT NEW.job
  OR OLD.start_at IS NOT NEW.start_at OR OLD.end_at IS NOT NEW.end_at
  OR OLD.claude_tokens IS NOT NEW.claude_tokens OR OLD.vendor_tokens IS NOT NEW.vendor_tokens
  OR OLD.vendor_cost_usd IS NOT NEW.vendor_cost_usd OR OLD.ref IS NOT NEW.ref
  OR OLD.via IS NOT NEW.via OR OLD.open IS NOT NEW.open
  OR OLD.session_id IS NOT NEW.session_id OR OLD.user_id IS NOT NEW.user_id
BEGIN
  INSERT INTO hosted_outbox (id,table_name,row_id,operation,queued_at)
  VALUES (NEW.record_id,'hub_interval',NEW.record_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(table_name,row_id) DO UPDATE SET
    operation=excluded.operation,queued_at=excluded.queued_at,
    generation=hosted_outbox.generation+1,attempts=0,last_error=NULL,
    quarantined_at=NULL,quarantine_reason=NULL,routing_space_id=NULL,routing_project=NULL,
    routing_project_record_id=NULL;
END;
