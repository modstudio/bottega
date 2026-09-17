ALTER TABLE send ADD COLUMN record_id TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX send_record_id ON send(record_id) WHERE record_id IS NOT NULL;
