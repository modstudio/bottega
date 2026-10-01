CREATE TABLE release_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  rung TEXT NOT NULL,
  candidate_commit TEXT NOT NULL,
  live_commit_before TEXT,
  rollback INTEGER NOT NULL CHECK (rollback IN (0,1)),
  rollback_reason TEXT,
  actor TEXT NOT NULL,
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  output_tail TEXT NOT NULL DEFAULT '',
  live_commit_after TEXT,
  live_matches_candidate INTEGER CHECK (live_matches_candidate IN (0,1)),
  warning TEXT,
  CHECK ((rollback = 1 AND rollback_reason IS NOT NULL) OR (rollback = 0 AND rollback_reason IS NULL)),
  CHECK ((finished_at IS NULL AND exit_code IS NULL) OR (finished_at IS NOT NULL AND exit_code IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX release_ledger_project_rung_started ON release_ledger(project,rung,started_at DESC,id DESC);
