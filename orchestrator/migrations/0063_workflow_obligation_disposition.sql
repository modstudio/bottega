ALTER TABLE workflow_obligation ADD COLUMN floor_deferrable INTEGER NOT NULL DEFAULT 1
  CHECK (floor_deferrable IN (0,1));
--> statement-breakpoint
ALTER TABLE workflow_obligation ADD COLUMN abandoned_at TEXT;
--> statement-breakpoint
ALTER TABLE workflow_obligation ADD COLUMN abandoned_reason TEXT;
