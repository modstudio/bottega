CREATE TABLE session_close_out (
  record_id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  clean INTEGER NOT NULL CHECK (clean IN (0,1)),
  recommendation TEXT NOT NULL CHECK (recommendation IN ('clear','brief')),
  mechanical_count INTEGER NOT NULL CHECK (mechanical_count >= 0),
  process_count INTEGER NOT NULL CHECK (process_count >= 0),
  error_count INTEGER NOT NULL CHECK (error_count >= 0),
  warning_count INTEGER NOT NULL CHECK (warning_count >= 0),
  swept_at TEXT
);
--> statement-breakpoint
CREATE INDEX session_close_out_session_closed_idx
  ON session_close_out(session_id,closed_at DESC,record_id DESC);
--> statement-breakpoint
CREATE INDEX session_close_out_sweep_idx
  ON session_close_out(clean,swept_at,closed_at);
