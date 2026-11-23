CREATE TABLE hosted_change_quarantine (
  id TEXT NOT NULL PRIMARY KEY,
  feed TEXT NOT NULL,
  space_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  raw_change TEXT NOT NULL,
  constraint_error TEXT NOT NULL,
  first_quarantined_at TEXT NOT NULL,
  last_quarantined_at TEXT NOT NULL,
  sightings INTEGER NOT NULL CHECK (sightings > 0),
  UNIQUE(feed, space_id, table_name, row_id)
);
CREATE INDEX hosted_change_quarantine_oldest
ON hosted_change_quarantine(first_quarantined_at, id);
