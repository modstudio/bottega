ALTER TABLE release_ledger ADD COLUMN record_id TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX release_ledger_record_id ON release_ledger(record_id) WHERE record_id IS NOT NULL;
