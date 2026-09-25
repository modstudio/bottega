ALTER TABLE run ADD COLUMN gate_requests_closed INTEGER NOT NULL DEFAULT 0 CHECK (gate_requests_closed IN (0,1));
--> statement-breakpoint
ALTER TABLE gate_execution ADD COLUMN cancelled_reason TEXT;
--> statement-breakpoint
ALTER TABLE gate_execution ADD COLUMN tooling_paths TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE gate_execution ADD COLUMN resolved_command TEXT;
