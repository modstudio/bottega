ALTER TABLE session_seen ADD COLUMN ancestor_pids TEXT;

CREATE TABLE host_pressure_sample (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sampled_at TEXT NOT NULL,
  loadavg REAL NOT NULL,
  ncpu INTEGER NOT NULL,
  pressure TEXT NOT NULL,
  processes TEXT,
  process_error TEXT
);

CREATE INDEX host_pressure_sample_sampled_at
  ON host_pressure_sample(sampled_at);
