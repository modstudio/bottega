ALTER TABLE project ADD COLUMN record_id TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX project_record_id_unique ON project(record_id);
