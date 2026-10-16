ALTER TABLE release_ledger ADD COLUMN project_id INTEGER REFERENCES project(id);
--> statement-breakpoint
-- BACKFILL
UPDATE release_ledger SET project_record_id=(SELECT record_id FROM project WHERE name=release_ledger.project)
WHERE project_record_id IS NULL
  AND (SELECT COUNT(*) FROM project WHERE name=release_ledger.project)=1;
-- /BACKFILL
