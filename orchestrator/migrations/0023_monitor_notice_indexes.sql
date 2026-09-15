CREATE INDEX run_parent_turn ON run(parent_run_id, turn);
--> statement-breakpoint
CREATE INDEX monitor_condition_latest
  ON monitor_condition(owner_session_id, kind, subject, condition_since, id);
