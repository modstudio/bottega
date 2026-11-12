ALTER TABLE day ADD COLUMN hosted_space_id TEXT;
--> statement-breakpoint
UPDATE day
SET hosted_space_id = (SELECT active_space_id FROM install_binding WHERE id=1)
WHERE record_id IS NOT NULL;
--> statement-breakpoint
INSERT INTO hosted_outbox (id,table_name,row_id,operation,queued_at)
SELECT record_id,'hub_day',record_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM day
WHERE record_id IS NOT NULL
ON CONFLICT(table_name,row_id) DO UPDATE SET
  operation=excluded.operation,queued_at=excluded.queued_at,
  generation=hosted_outbox.generation+1,attempts=0,last_error=NULL,
  quarantined_at=NULL,quarantine_reason=NULL,
  routing_space_id=NULL,routing_project=NULL,routing_project_record_id=NULL;
