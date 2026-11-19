ALTER TABLE run ADD COLUMN own_failure_kind TEXT;

-- BACKFILL
UPDATE run AS target
   SET own_failure_kind = failure_kind
 WHERE parent_run_record_id IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM run child WHERE child.parent_run_record_id = target.record_id);
-- /BACKFILL
