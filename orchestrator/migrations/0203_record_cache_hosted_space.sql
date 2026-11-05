ALTER TABLE doc ADD COLUMN space_id TEXT;
--> statement-breakpoint
ALTER TABLE subject ADD COLUMN space_id TEXT;
--> statement-breakpoint
CREATE INDEX doc_space_id ON doc(space_id);
--> statement-breakpoint
CREATE INDEX subject_space_id ON subject(space_id);
