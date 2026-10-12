ALTER TABLE day ADD COLUMN machine_id TEXT;
--> statement-breakpoint
DROP TRIGGER day_hosted_update;
--> statement-breakpoint
CREATE TRIGGER day_hosted_update AFTER UPDATE ON day
WHEN OLD.machine_id IS NOT NEW.machine_id
  OR OLD.claude_tokens IS NOT NEW.claude_tokens OR OLD.cache_read IS NOT NEW.cache_read
  OR OLD.messages IS NOT NEW.messages OR OLD.tasks IS NOT NEW.tasks
  OR OLD.canon_tokens IS NOT NEW.canon_tokens OR OLD.other_tokens IS NOT NEW.other_tokens
  OR OLD.commits IS NOT NEW.commits OR OLD.files IS NOT NEW.files
  OR OLD.lines_product IS NOT NEW.lines_product OR OLD.lines_test IS NOT NEW.lines_test
  OR OLD.lines_docs IS NOT NEW.lines_docs OR OLD.lines_config IS NOT NEW.lines_config
  OR OLD.lines_generated IS NOT NEW.lines_generated
  OR (OLD.collected_at IS NOT NEW.collected_at AND NEW.day=(SELECT max(day) FROM day))
BEGIN
  INSERT INTO hosted_outbox (id,table_name,row_id,operation,queued_at)
  VALUES (NEW.record_id,'hub_day',NEW.record_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(table_name,row_id) DO UPDATE SET
    operation=excluded.operation,queued_at=excluded.queued_at,
    generation=hosted_outbox.generation+1,attempts=0,last_error=NULL,
    quarantined_at=NULL,quarantine_reason=NULL,routing_space_id=NULL,routing_project=NULL;
END;
--> statement-breakpoint
-- BACKFILL
INSERT INTO hosted_outbox (id,table_name,row_id,operation,queued_at)
SELECT record_id,'hub_day',record_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM day
WHERE machine_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM setting WHERE key='migration.0033.day-machine-offered')
ON CONFLICT(table_name,row_id) DO UPDATE SET
  operation=excluded.operation,queued_at=excluded.queued_at,
  generation=hosted_outbox.generation+1,attempts=0,last_error=NULL,
  quarantined_at=NULL,quarantine_reason=NULL,routing_space_id=NULL,routing_project=NULL;
INSERT OR IGNORE INTO setting(key,value)
SELECT 'migration.0033.day-machine-offered','true'
WHERE NOT EXISTS (SELECT 1 FROM day WHERE machine_id IS NULL);
-- /BACKFILL
