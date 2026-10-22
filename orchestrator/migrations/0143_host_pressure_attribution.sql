ALTER TABLE session_seen ADD COLUMN ancestor_chain TEXT;
ALTER TABLE session_seen ADD COLUMN ancestor_confirmed_at TEXT;

CREATE TABLE host_pressure_sample (
  record_id TEXT PRIMARY KEY NOT NULL,
  sampled_at TEXT NOT NULL UNIQUE,
  loadavg REAL NOT NULL,
  ncpu INTEGER NOT NULL,
  memory_pressure TEXT NOT NULL,
  processes TEXT,
  process_error TEXT,
  observation_elapsed_ms REAL NOT NULL,
  observation_cpu_ms REAL NOT NULL
);
