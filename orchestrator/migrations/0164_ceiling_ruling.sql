ALTER TABLE landing_override ADD COLUMN attribution TEXT NOT NULL DEFAULT 'operator'
  CHECK (attribution IN ('operator','architect-ceiling'));
--> statement-breakpoint
ALTER TABLE landing_override ADD COLUMN missing_lenses TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(missing_lenses) AND json_type(missing_lenses)='array');
