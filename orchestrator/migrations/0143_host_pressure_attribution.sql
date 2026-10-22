ALTER TABLE session_seen ADD COLUMN ancestor_pids TEXT;

CREATE TABLE host_pressure_sample (
  record_id TEXT PRIMARY KEY NOT NULL,
  sampled_at TEXT NOT NULL UNIQUE,
  loadavg REAL NOT NULL,
  ncpu INTEGER NOT NULL,
  pressure TEXT NOT NULL,
  processes TEXT,
  process_error TEXT
);
