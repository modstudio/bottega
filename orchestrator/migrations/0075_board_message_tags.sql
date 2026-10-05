CREATE TABLE board_message_tag (
  message_id INTEGER NOT NULL REFERENCES board_message(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task','path','topic')),
  value TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('sender','inferred')),
  PRIMARY KEY (message_id, kind, value, origin)
);

CREATE INDEX board_message_tag_message ON board_message_tag(message_id);
