ALTER TABLE run ADD COLUMN record_id TEXT;
CREATE UNIQUE INDEX run_record_id_unique ON run(record_id);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  synced_at TEXT
);

CREATE INDEX outbox_synced_at ON outbox(synced_at);
