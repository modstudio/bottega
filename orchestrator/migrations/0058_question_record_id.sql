ALTER TABLE question ADD COLUMN record_id TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX question_record_id_unique ON question(record_id);
