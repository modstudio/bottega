-- BACKFILL
DELETE FROM outbox
WHERE kind='contention'
  AND synced_at IS NOT NULL
  AND quarantined_at IS NULL
  AND retired_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM contention WHERE contention.record_id=outbox.row_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM outbox_quarantine_audit audit WHERE audit.outbox_id=outbox.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM outbox_redaction_audit audit WHERE audit.outbox_id=outbox.id
  );
-- /BACKFILL
