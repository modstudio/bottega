ALTER TABLE run ADD COLUMN own_failure_kind TEXT;

-- BACKFILL
UPDATE run AS target
   SET own_failure_kind = failure_kind;
-- /BACKFILL
