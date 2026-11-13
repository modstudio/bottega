CREATE TABLE brief_injection (
  record_id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('startup','resume','clear','compact')),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  lines INTEGER NOT NULL CHECK (lines >= 0),
  cursors INTEGER NOT NULL CHECK (cursors >= 0),
  keyless_cursors INTEGER NOT NULL CHECK (keyless_cursors >= 0 AND keyless_cursors <= cursors),
  keyless_idle_max_ms INTEGER CHECK (keyless_idle_max_ms IS NULL OR keyless_idle_max_ms >= 0),
  over_cap INTEGER NOT NULL CHECK (over_cap IN (0,1))
);
--> statement-breakpoint
CREATE INDEX brief_injection_session_at_idx ON brief_injection(session_id,at);
