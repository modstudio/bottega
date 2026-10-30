CREATE TABLE hosted_pressure_cache (
  record_id TEXT NOT NULL PRIMARY KEY,
  singleton INTEGER NOT NULL UNIQUE CHECK (singleton = 1),
  checked_at TEXT NOT NULL,
  state TEXT NOT NULL,
  onset_at TEXT,
  below_since TEXT,
  last_sample TEXT,
  last_error TEXT
);
