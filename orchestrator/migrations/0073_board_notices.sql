CREATE TABLE presence (
  session_id TEXT PRIMARY KEY CHECK (session_id <> 'operator'),
  harness TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'architect'),
  machine TEXT NOT NULL,
  project TEXT NOT NULL,
  cwd TEXT NOT NULL,
  current_task_key TEXT,
  last_seen TEXT NOT NULL
);

CREATE TABLE board_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind = 'notice'),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('operator','architect')),
  author_session TEXT,
  audience TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  ack_required INTEGER NOT NULL CHECK (ack_required IN (0,1)),
  ack_deadline TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  withdrawn_at TEXT,
  CHECK ((author_kind = 'operator' AND author_session IS NULL) OR
         (author_kind = 'architect' AND author_session IS NOT NULL AND author_session <> 'operator'))
);

CREATE TABLE board_receipt (
  message_id INTEGER NOT NULL REFERENCES board_message(id) ON DELETE CASCADE,
  reader_session TEXT NOT NULL,
  audience_at_posting INTEGER NOT NULL CHECK (audience_at_posting IN (0,1)),
  delivered_at TEXT,
  acknowledged_at TEXT,
  PRIMARY KEY (message_id, reader_session)
);

CREATE INDEX board_message_delivery ON board_message(expires_at, withdrawn_at, created_at);
CREATE INDEX board_message_author_rate ON board_message(author_kind, author_session, created_at);
CREATE INDEX presence_last_seen ON presence(last_seen);
