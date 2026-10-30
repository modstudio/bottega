CREATE TABLE session_board_hold (
  record_id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_record_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);

CREATE UNIQUE INDEX session_board_hold_open
ON session_board_hold(session_id,message_record_id)
WHERE released_at IS NULL;
