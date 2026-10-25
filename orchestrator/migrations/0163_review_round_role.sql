ALTER TABLE review ADD COLUMN role TEXT NOT NULL DEFAULT 'round'
  CHECK (role IN ('round','supplementary'));
--> statement-breakpoint
ALTER TABLE run ADD COLUMN review_role TEXT
  CHECK (review_role IS NULL OR review_role IN ('round','supplementary'));
--> statement-breakpoint
-- Historical marking is safe to re-run because only legacy NULL-role runs are eligible.
-- BACKFILL
UPDATE review
   SET role='supplementary'
 WHERE completed_at IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM review_lens lens WHERE lens.review_record_id=review.record_id
   )
   AND NOT EXISTS (
     SELECT 1 FROM review_lens lens
      WHERE lens.review_record_id=review.record_id AND lens.lens<>'issue-blast-radius'
   )
   AND NOT EXISTS (
     SELECT 1
       FROM review_lens lens JOIN run ON run.record_id=lens.run_record_id
      WHERE lens.review_record_id=review.record_id AND run.review_role IS NOT NULL
   )
   AND EXISTS (
     SELECT 1 FROM project
      WHERE project.record_id=review.project_record_id
        AND project.settings IS NOT NULL
        AND json_valid(project.settings)
   )
   AND NOT EXISTS (
     SELECT 1
       FROM project, json_each(project.settings, '$.review.lenses') declared
      WHERE project.record_id=review.project_record_id
        AND project.settings IS NOT NULL
        AND json_valid(project.settings)
        AND json_extract(declared.value, '$.lens')='issue-blast-radius'
   );
-- /BACKFILL
