ALTER TABLE review ADD COLUMN patch_id TEXT;
--> statement-breakpoint
ALTER TABLE review ADD COLUMN path_set TEXT;
--> statement-breakpoint
ALTER TABLE review ADD COLUMN commit_message TEXT;
--> statement-breakpoint
ALTER TABLE review ADD COLUMN outdated_at TEXT;
--> statement-breakpoint
ALTER TABLE review ADD COLUMN outdated_reason TEXT;
--> statement-breakpoint
ALTER TABLE run ADD COLUMN review_provenance TEXT;
--> statement-breakpoint
ALTER TABLE run ADD COLUMN provenance_status TEXT;
--> statement-breakpoint
ALTER TABLE review_lens ADD COLUMN mcp_tools TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE review_lens ADD COLUMN docs_read TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE review_lens ADD COLUMN substitutes TEXT NOT NULL DEFAULT '[]';
