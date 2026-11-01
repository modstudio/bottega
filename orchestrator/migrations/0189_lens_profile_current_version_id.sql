ALTER TABLE lens_profile ADD COLUMN current_version_id TEXT;
--> statement-breakpoint
-- BACKFILL
UPDATE lens_profile
SET current_version_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE current_version_id IS NULL;
-- /BACKFILL
