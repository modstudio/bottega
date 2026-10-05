ALTER TABLE presence ADD COLUMN first_seen TEXT;
UPDATE presence SET first_seen=last_seen;

CREATE TABLE hosted_board_message_cache (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  thread_root_id TEXT,
  revision TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE hosted_board_message_tag_cache (
  message_id TEXT NOT NULL REFERENCES hosted_board_message_cache(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('sender','inferred')),
  PRIMARY KEY (message_id,kind,value,origin)
);

CREATE TABLE hosted_board_receipt_cache (
  message_id TEXT NOT NULL REFERENCES hosted_board_message_cache(id) ON DELETE CASCADE,
  reader_session TEXT NOT NULL,
  audience_at_posting INTEGER NOT NULL CHECK (audience_at_posting IN (0,1)),
  delivered_at TEXT,
  acknowledged_at TEXT,
  pending_sync INTEGER NOT NULL DEFAULT 0 CHECK (pending_sync IN (0,1)),
  PRIMARY KEY (message_id,reader_session)
);

CREATE INDEX hosted_board_cache_thread ON hosted_board_message_cache(thread_root_id);
CREATE INDEX hosted_board_receipt_pending ON hosted_board_receipt_cache(pending_sync);
