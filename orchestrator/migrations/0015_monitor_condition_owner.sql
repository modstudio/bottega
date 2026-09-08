ALTER TABLE monitor_condition ADD COLUMN owner_session_id TEXT;
--> statement-breakpoint
ALTER TABLE monitor_condition ADD COLUMN delivered_at TEXT;
--> statement-breakpoint
CREATE INDEX monitor_condition_owner_delivery
  ON monitor_condition(owner_session_id, delivered_at);
