ALTER TABLE interval ADD COLUMN hosted_space_id TEXT;
--> statement-breakpoint
ALTER TABLE hosted_outbox ADD COLUMN routing_space_id TEXT;
--> statement-breakpoint
ALTER TABLE hosted_outbox ADD COLUMN routing_project TEXT;
--> statement-breakpoint
UPDATE interval
SET hosted_space_id = (
  SELECT destination_space_id FROM record_ledger
  WHERE table_name='interval' AND local_key=interval.record_id
)
WHERE EXISTS (
  SELECT 1 FROM record_ledger
  WHERE table_name='interval' AND local_key=interval.record_id
    AND destination_space_id IS NOT NULL
);
--> statement-breakpoint
INSERT INTO hosted_outbox
  (id,table_name,row_id,operation,queued_at,routing_space_id,routing_project)
SELECT local_key,'hub_interval',local_key,'delete',synced_at,destination_space_id,NULL
FROM record_ledger ledger
WHERE table_name='interval'
  AND destination_space_id IS NOT NULL
  AND length(local_key)=36
  AND local_key GLOB '[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'
  AND NOT EXISTS (SELECT 1 FROM interval WHERE record_id=ledger.local_key)
ON CONFLICT(table_name,row_id) DO UPDATE SET
  operation=excluded.operation,queued_at=excluded.queued_at,
  generation=hosted_outbox.generation+1,attempts=0,last_error=NULL,
  quarantined_at=NULL,quarantine_reason=NULL,
  routing_space_id=excluded.routing_space_id,routing_project=excluded.routing_project;
--> statement-breakpoint
DROP TABLE record_ledger;
--> statement-breakpoint
CREATE TRIGGER interval_hosted_insert AFTER INSERT ON interval BEGIN
  INSERT INTO hosted_outbox (id,table_name,row_id,operation,queued_at)
  VALUES (NEW.record_id,'hub_interval',NEW.record_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(table_name,row_id) DO UPDATE SET
    operation=excluded.operation,queued_at=excluded.queued_at,
    generation=hosted_outbox.generation+1,attempts=0,last_error=NULL,
    quarantined_at=NULL,quarantine_reason=NULL,routing_space_id=NULL,routing_project=NULL;
END;
--> statement-breakpoint
CREATE TRIGGER interval_hosted_update AFTER UPDATE ON interval
WHEN OLD.task_key IS NOT NEW.task_key OR OLD.project IS NOT NEW.project
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
    quarantined_at=NULL,quarantine_reason=NULL,routing_space_id=NULL,routing_project=NULL;
END;
--> statement-breakpoint
CREATE TRIGGER interval_hosted_delete AFTER DELETE ON interval BEGIN
  INSERT INTO hosted_outbox
    (id,table_name,row_id,operation,queued_at,routing_space_id,routing_project)
  VALUES
    (OLD.record_id,'hub_interval',OLD.record_id,'delete',strftime('%Y-%m-%dT%H:%M:%fZ','now'),OLD.hosted_space_id,OLD.project)
  ON CONFLICT(table_name,row_id) DO UPDATE SET
    operation=excluded.operation,queued_at=excluded.queued_at,
    generation=hosted_outbox.generation+1,attempts=0,last_error=NULL,
    quarantined_at=NULL,quarantine_reason=NULL,
    routing_space_id=excluded.routing_space_id,routing_project=excluded.routing_project;
END;
--> statement-breakpoint
CREATE TRIGGER day_hosted_insert AFTER INSERT ON day BEGIN
  INSERT INTO hosted_outbox (id,table_name,row_id,operation,queued_at)
  VALUES (NEW.record_id,'hub_day',NEW.record_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(table_name,row_id) DO UPDATE SET
    operation=excluded.operation,queued_at=excluded.queued_at,
    generation=hosted_outbox.generation+1,attempts=0,last_error=NULL,
    quarantined_at=NULL,quarantine_reason=NULL,routing_space_id=NULL,routing_project=NULL;
END;
--> statement-breakpoint
CREATE TRIGGER day_hosted_update AFTER UPDATE ON day
WHEN OLD.claude_tokens IS NOT NEW.claude_tokens OR OLD.cache_read IS NOT NEW.cache_read
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
INSERT OR IGNORE INTO hosted_outbox (id,table_name,row_id,operation,queued_at)
SELECT record_id,'hub_interval',record_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM interval
WHERE NOT EXISTS (SELECT 1 FROM setting WHERE key='migration.0028.outbox-evidence-offered');
INSERT OR IGNORE INTO hosted_outbox (id,table_name,row_id,operation,queued_at)
SELECT record_id,'hub_day',record_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM day
WHERE NOT EXISTS (SELECT 1 FROM setting WHERE key='migration.0028.outbox-evidence-offered');
INSERT OR IGNORE INTO setting(key,value)
VALUES ('migration.0028.outbox-evidence-offered','true');
-- /BACKFILL
