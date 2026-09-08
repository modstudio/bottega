ALTER TABLE agent ADD COLUMN jobs TEXT CHECK (jobs IS NULL OR json_valid(jobs));
--> statement-breakpoint
ALTER TABLE agent ADD COLUMN preferred_jobs TEXT CHECK (preferred_jobs IS NULL OR json_valid(preferred_jobs));
--> statement-breakpoint
ALTER TABLE agent ADD COLUMN max_concurrent INTEGER CHECK (max_concurrent IS NULL OR max_concurrent > 0);
