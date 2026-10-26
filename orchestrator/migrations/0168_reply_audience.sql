PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TEMP TABLE board_message_before_reply_audience AS SELECT * FROM board_message;
CREATE TEMP TABLE board_message_tag_before_reply_audience AS SELECT * FROM board_message_tag;
CREATE TEMP TABLE board_receipt_before_reply_audience AS SELECT * FROM board_receipt;
--> statement-breakpoint
DROP TABLE board_message_tag;
DROP TABLE board_receipt;
DROP TABLE board_message;
--> statement-breakpoint
CREATE TABLE board_message (
  record_id TEXT NOT NULL PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('notice','suggestion','question','reply')),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('operator','architect','worker')), author_session TEXT,
  author_run_record_id TEXT REFERENCES run(record_id), audience TEXT, title TEXT, body TEXT NOT NULL,
  ack_required INTEGER NOT NULL CHECK (ack_required IN (0,1)), ack_deadline TEXT, expires_at TEXT,
  created_at TEXT NOT NULL, withdrawn_at TEXT, author_harness TEXT, author_project TEXT,
  thread_root_record_id TEXT REFERENCES board_message(record_id) ON DELETE CASCADE,
  accepted_reply_record_id TEXT REFERENCES board_message(record_id), accepted_by TEXT, accepted_at TEXT,
  note_record_id TEXT, note_label TEXT, note_pending_error TEXT, note_filing_started_at TEXT,
  claim_record_id TEXT REFERENCES board_claim(record_id),
  purpose TEXT CHECK (purpose IS NULL OR purpose IN ('information','request','standing')),
  author_project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  CHECK ((author_kind='operator' AND author_session IS NULL AND author_run_record_id IS NULL) OR
         (author_kind='architect' AND author_session IS NOT NULL AND author_session<>'operator') OR
         (author_kind='worker' AND author_session IS NULL AND author_run_record_id IS NOT NULL)),
  CHECK ((kind='reply' AND thread_root_record_id IS NOT NULL
           AND (audience IS NULL OR audience IN ('participants','acknowledged','audience','operator')
             OR (audience LIKE 'session:%' AND audience <> 'session:'))
           AND title IS NULL AND ack_required=0 AND ack_deadline IS NULL AND expires_at IS NULL) OR
         (kind<>'reply' AND thread_root_record_id IS NULL AND audience IS NOT NULL AND title IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK ((accepted_reply_record_id IS NULL AND accepted_by IS NULL AND accepted_at IS NULL) OR
         (kind='question' AND accepted_reply_record_id IS NOT NULL AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK (kind='question' OR (note_record_id IS NULL AND note_label IS NULL AND note_pending_error IS NULL AND note_filing_started_at IS NULL))
);
INSERT INTO board_message SELECT * FROM board_message_before_reply_audience;
--> statement-breakpoint
CREATE TABLE board_message_tag (
  record_id TEXT NOT NULL PRIMARY KEY,
  message_record_id TEXT NOT NULL REFERENCES board_message(record_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task','path','topic')), value TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('sender','inferred')),
  UNIQUE(message_record_id,kind,value,origin)
);
INSERT INTO board_message_tag SELECT * FROM board_message_tag_before_reply_audience;
CREATE TABLE board_receipt (
  record_id TEXT NOT NULL PRIMARY KEY,
  message_record_id TEXT NOT NULL REFERENCES board_message(record_id) ON DELETE CASCADE,
  reader_session TEXT NOT NULL, audience_at_posting INTEGER NOT NULL CHECK (audience_at_posting IN (0,1)),
  delivered_at TEXT, acknowledged_at TEXT,
  successor INTEGER NOT NULL DEFAULT 0 CHECK (successor IN (0,1)),
  UNIQUE(message_record_id,reader_session)
);
INSERT INTO board_receipt SELECT * FROM board_receipt_before_reply_audience;
--> statement-breakpoint
CREATE INDEX board_message_author_project_record_id ON board_message(author_project_record_id);
CREATE INDEX board_message_author_rate ON board_message(author_kind,author_session,author_run_record_id,created_at);
CREATE INDEX board_message_delivery ON board_message(expires_at,withdrawn_at,created_at);
CREATE INDEX board_message_thread ON board_message(thread_root_record_id,created_at,number);
CREATE INDEX board_message_accepted_reply ON board_message(accepted_reply_record_id);
CREATE INDEX board_message_claim ON board_message(claim_record_id);
CREATE INDEX board_message_author_run ON board_message(author_run_record_id);
CREATE INDEX board_message_tag_message ON board_message_tag(message_record_id);
CREATE INDEX board_receipt_message ON board_receipt(message_record_id);
--> statement-breakpoint
DROP TABLE board_message_before_reply_audience;
DROP TABLE board_message_tag_before_reply_audience;
DROP TABLE board_receipt_before_reply_audience;
