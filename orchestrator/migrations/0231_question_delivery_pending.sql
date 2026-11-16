CREATE TABLE question_delivery_pending (
  question_record_id TEXT NOT NULL PRIMARY KEY,
  run_record_id TEXT,
  pending_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO question_delivery_pending(question_record_id,run_record_id,pending_at)
SELECT record_id,run_record_id,delivery_pending_at FROM question
WHERE delivery_pending_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX question_delivery_pending_run_record_id_idx
ON question_delivery_pending(run_record_id);
--> statement-breakpoint
UPDATE outbox
SET retired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    retirement_reason='question outbox kind retired; questions write directly to the record'
WHERE kind='question' AND synced_at IS NULL AND quarantined_at IS NULL AND retired_at IS NULL;
