CREATE TEMP TABLE board_receipt_before_threads AS SELECT * FROM board_receipt;
CREATE TEMP TABLE board_message_tag_before_threads AS SELECT * FROM board_message_tag;

DROP TABLE board_receipt;
DROP TABLE board_message_tag;

ALTER TABLE board_message RENAME TO board_message_before_threads;

CREATE TABLE board_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('notice','suggestion','question','reply')),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('operator','architect','worker')),
  author_session TEXT,
  author_run_id INTEGER REFERENCES run(id),
  audience TEXT,
  title TEXT,
  body TEXT NOT NULL,
  ack_required INTEGER NOT NULL CHECK (ack_required IN (0,1)),
  ack_deadline TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  withdrawn_at TEXT,
  author_harness TEXT,
  author_project TEXT,
  thread_root_id INTEGER REFERENCES board_message(id) ON DELETE CASCADE,
  accepted_reply_id INTEGER REFERENCES board_message(id),
  accepted_by TEXT,
  accepted_at TEXT,
  note_id INTEGER,
  note_pending_error TEXT,
  CHECK (
    (author_kind = 'operator' AND author_session IS NULL AND author_run_id IS NULL) OR
    (author_kind = 'architect' AND author_session IS NOT NULL AND author_session <> 'operator') OR
    (author_kind = 'worker' AND author_session IS NULL AND author_run_id IS NOT NULL)
  ),
  CHECK (
    (kind = 'reply' AND thread_root_id IS NOT NULL AND audience IS NULL AND title IS NULL
      AND ack_required = 0 AND ack_deadline IS NULL AND expires_at IS NULL) OR
    (kind <> 'reply' AND thread_root_id IS NULL AND audience IS NOT NULL AND title IS NOT NULL
      AND expires_at IS NOT NULL)
  ),
  CHECK (
    (accepted_reply_id IS NULL AND accepted_by IS NULL AND accepted_at IS NULL) OR
    (kind = 'question' AND accepted_reply_id IS NOT NULL AND accepted_by IS NOT NULL
      AND accepted_at IS NOT NULL)
  ),
  CHECK (kind = 'question' OR (note_id IS NULL AND note_pending_error IS NULL))
);

INSERT INTO board_message
  (id,kind,author_kind,author_session,author_run_id,audience,title,body,ack_required,
   ack_deadline,expires_at,created_at,withdrawn_at,author_harness,author_project)
SELECT id,kind,author_kind,author_session,author_run_id,audience,title,body,ack_required,
       ack_deadline,expires_at,created_at,withdrawn_at,author_harness,author_project
FROM board_message_before_threads;

DROP TABLE board_message_before_threads;

CREATE TABLE board_receipt (
  message_id INTEGER NOT NULL REFERENCES board_message(id) ON DELETE CASCADE,
  reader_session TEXT NOT NULL,
  audience_at_posting INTEGER NOT NULL CHECK (audience_at_posting IN (0,1)),
  delivered_at TEXT,
  acknowledged_at TEXT,
  PRIMARY KEY (message_id, reader_session)
);

INSERT INTO board_receipt SELECT * FROM board_receipt_before_threads;
DROP TABLE board_receipt_before_threads;

CREATE TABLE board_message_tag (
  message_id INTEGER NOT NULL REFERENCES board_message(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task','path','topic')),
  value TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('sender','inferred')),
  PRIMARY KEY (message_id, kind, value, origin)
);

INSERT INTO board_message_tag SELECT * FROM board_message_tag_before_threads;
DROP TABLE board_message_tag_before_threads;

CREATE INDEX board_message_delivery ON board_message(expires_at, withdrawn_at, created_at);
CREATE INDEX board_message_author_rate
  ON board_message(author_kind, author_session, author_run_id, created_at);
CREATE INDEX board_message_tag_message ON board_message_tag(message_id);
CREATE INDEX board_message_thread ON board_message(thread_root_id, created_at, id);
