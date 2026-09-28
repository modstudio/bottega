ALTER TABLE landing_override ADD COLUMN patch_id TEXT;
--> statement-breakpoint
ALTER TABLE landing_override ADD COLUMN path_set TEXT
  CHECK (path_set IS NULL OR json_valid(path_set));
