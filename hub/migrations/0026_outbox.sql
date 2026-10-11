CREATE TABLE hosted_outbox (
  id                TEXT PRIMARY KEY,
  table_name        TEXT NOT NULL,
  row_id            TEXT NOT NULL,
  operation         TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  queued_at          TEXT NOT NULL,
  generation         INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error         TEXT,
  quarantined_at     TEXT,
  quarantine_reason TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX hosted_outbox_one_entry
  ON hosted_outbox(table_name,row_id,operation);
--> statement-breakpoint
CREATE INDEX hosted_outbox_pending
  ON hosted_outbox(queued_at,id)
  WHERE quarantined_at IS NULL;
--> statement-breakpoint
-- BACKFILL
INSERT OR IGNORE INTO hosted_outbox
  (id,table_name,row_id,operation,queued_at)
SELECT
  json_extract(json_each.value,'$.eventRecordId'),
  'hub_task_status_event',
  json_extract(json_each.value,'$.eventRecordId'),
  'upsert',
  json_extract(json_each.value,'$.at')
FROM setting,
  json_each(CASE
    WHEN json_valid(setting.value) AND json_type(setting.value)='array' THEN setting.value
    ELSE '[]'
  END)
WHERE setting.key='tracker.status-events.pending-mirror'
  AND json_extract(json_each.value,'$.eventRecordId') IS NOT NULL;
DELETE FROM setting WHERE key='tracker.status-events.pending-mirror';
-- /BACKFILL
