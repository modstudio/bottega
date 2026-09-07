-- Re-runnable repair for rows written by processes that started before
-- project_id existed. 0004_lens_catalogue.sql stays byte-identical.
-- BACKFILL
UPDATE run SET project_id=(SELECT id FROM project WHERE name=run.repo)
 WHERE repo IS NOT NULL AND project_id IS NULL;
--> statement-breakpoint
UPDATE run SET project_id=(SELECT id FROM project WHERE name='bottega')
 WHERE repo IN ('devbox','devbox-ops') AND project_id IS NULL;
--> statement-breakpoint
UPDATE canon_pack SET project_id=(SELECT id FROM project WHERE name=canon_pack.project)
 WHERE project IS NOT NULL AND project_id IS NULL;
--> statement-breakpoint
UPDATE landing SET project_id=(SELECT id FROM project WHERE name=landing.project)
 WHERE project_id IS NULL;
--> statement-breakpoint
UPDATE landing_override SET project_id=(SELECT id FROM project WHERE name=landing_override.project)
 WHERE project_id IS NULL;
--> statement-breakpoint
UPDATE landing_review_carry SET project_id=(SELECT id FROM project WHERE name=landing_review_carry.project)
 WHERE project_id IS NULL;
--> statement-breakpoint
UPDATE doc SET project_id=(SELECT id FROM project WHERE name=doc.subject)
 WHERE scope='project' AND project_id IS NULL;
--> statement-breakpoint
UPDATE doc_revision SET project_id=(SELECT id FROM project WHERE name=doc_revision.subject)
 WHERE scope='project' AND project_id IS NULL;
--> statement-breakpoint
UPDATE review SET project_id=(
  SELECT MIN(r.project_id) FROM review_lens rl JOIN run r ON r.id=rl.run_id
   WHERE rl.review_id=review.id
) WHERE project_id IS NULL
    AND EXISTS (SELECT 1 FROM review_lens rl JOIN run r ON r.id=rl.run_id
                 WHERE rl.review_id=review.id AND r.project_id IS NOT NULL)
    AND 1=(SELECT COUNT(DISTINCT r.project_id) FROM review_lens rl JOIN run r ON r.id=rl.run_id
            WHERE rl.review_id=review.id AND r.project_id IS NOT NULL)
    AND 0=(SELECT COUNT(*) FROM review_lens rl JOIN run r ON r.id=rl.run_id
            WHERE rl.review_id=review.id AND r.project_id IS NULL)
    AND 1=(SELECT COUNT(DISTINCT CASE
              WHEN r.repo IN ('devbox','devbox-ops') THEN 'bottega'
              ELSE r.repo
            END) FROM review_lens rl JOIN run r ON r.id=rl.run_id
            WHERE rl.review_id=review.id);
-- /BACKFILL
