ALTER TABLE run ADD COLUMN own_failure_kind TEXT;
--> statement-breakpoint
UPDATE run AS target
   SET own_failure_kind = failure_kind
 WHERE parent_run_record_id IS NULL
   AND EXISTS (
     SELECT 1 FROM run child WHERE child.parent_run_record_id = target.record_id
   );

-- BACKFILL
UPDATE run AS target
   SET own_failure_kind = failure_kind
 WHERE (
       parent_run_record_id IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM run child WHERE child.parent_run_record_id = target.record_id
       )
     )
   AND own_failure_kind IS NOT failure_kind;
-- /BACKFILL
