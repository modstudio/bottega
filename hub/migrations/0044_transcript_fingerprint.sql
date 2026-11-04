CREATE TABLE transcript_fingerprint (
  path TEXT NOT NULL PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL
);
