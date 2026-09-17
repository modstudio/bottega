ALTER TABLE note ADD COLUMN record_id TEXT;
--> statement-breakpoint
ALTER TABLE note_acknowledgement ADD COLUMN record_id TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX note_record_id ON note(record_id) WHERE record_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX note_acknowledgement_record_id ON note_acknowledgement(record_id) WHERE record_id IS NOT NULL;
