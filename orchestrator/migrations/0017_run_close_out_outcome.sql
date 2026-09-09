ALTER TABLE run ADD COLUMN close_out_outcome TEXT
  CHECK (close_out_outcome IS NULL OR close_out_outcome IN ('released','held','live','absent','failed'));
--> statement-breakpoint
ALTER TABLE run ADD COLUMN close_out_detail TEXT;
--> statement-breakpoint
ALTER TABLE run ADD COLUMN close_out_attempted_at TEXT;
