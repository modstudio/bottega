CREATE TABLE record_ledger (
  table_name  TEXT NOT NULL,
  local_key   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  synced_at   TEXT NOT NULL,
  PRIMARY KEY (table_name, local_key)
);
