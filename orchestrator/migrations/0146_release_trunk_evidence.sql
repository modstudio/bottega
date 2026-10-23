ALTER TABLE release_ledger ADD COLUMN trunk TEXT;
--> statement-breakpoint
ALTER TABLE release_ledger ADD COLUMN trunk_tip TEXT;
--> statement-breakpoint
ALTER TABLE release_ledger ADD COLUMN commits_behind_trunk INTEGER;
--> statement-breakpoint
ALTER TABLE release_ledger ADD COLUMN behind_trunk_reason TEXT;
