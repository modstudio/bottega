CREATE TABLE transcript_fingerprint (
  record_id TEXT NOT NULL PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL
);
