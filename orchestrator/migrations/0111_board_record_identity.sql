PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
-- newRecordId() is the runtime minter; these are migration-only random UUID-v4 values.
CREATE TEMP TABLE board_message_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='board_message'),0) seq;
CREATE TEMP TABLE board_claim_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='board_claim'),0) seq;
CREATE TEMP TABLE board_reach_delivery_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='board_reach_delivery'),0) seq;
CREATE TEMP TABLE board_reach_recording_failure_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='board_reach_recording_failure'),0) seq;
CREATE TEMP TABLE board_claim_before_record_identity AS SELECT * FROM board_claim;
CREATE TEMP TABLE board_message_before_record_identity AS SELECT * FROM board_message;
CREATE TEMP TABLE board_message_tag_before_record_identity AS SELECT * FROM board_message_tag;
CREATE TEMP TABLE board_receipt_before_record_identity AS SELECT * FROM board_receipt;
CREATE TEMP TABLE board_hosted_adoption_ledger_before_record_identity AS SELECT * FROM board_hosted_adoption_ledger;
CREATE TEMP TABLE board_hosted_adoption_receipt_before_record_identity AS SELECT * FROM board_hosted_adoption_receipt;
CREATE TEMP TABLE board_reach_delivery_before_record_identity AS SELECT * FROM board_reach_delivery;
CREATE TEMP TABLE board_reach_recording_failure_before_record_identity AS SELECT * FROM board_reach_recording_failure;
--> statement-breakpoint
DROP TABLE board_message_tag;
DROP TABLE board_receipt;
DROP TABLE board_message;
DROP TABLE board_claim;
DROP TABLE board_hosted_adoption_ledger;
DROP TABLE board_hosted_adoption_receipt;
DROP TABLE board_reach_delivery;
DROP TABLE board_reach_recording_failure;
--> statement-breakpoint
CREATE TABLE board_claim (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('task','path','resource')),
  subject_value TEXT NOT NULL,
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('operator','architect')),
  holder_session TEXT,
  note TEXT,
  run_id INTEGER REFERENCES run(id),
  duration_ms INTEGER NOT NULL,
  taken_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  lapses_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT CHECK (close_reason IN ('released','lapsed','run-ended','task-closed','taken-over')),
  superseded_by_claim_id INTEGER REFERENCES board_claim(id),
  record_id TEXT NOT NULL,
  CHECK (
    (holder_kind = 'operator' AND holder_session IS NULL) OR
    (holder_kind = 'architect' AND holder_session IS NOT NULL)
  ),
  CHECK ((closed_at IS NULL AND close_reason IS NULL) OR
         (closed_at IS NOT NULL AND close_reason IS NOT NULL))
);
INSERT INTO board_claim
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
FROM board_claim_before_record_identity ORDER BY id;
UPDATE board_claim SET record_id=(
  SELECT hosted_id FROM board_hosted_adoption_ledger_before_record_identity
  WHERE local_kind='claim' AND local_id=board_claim.id AND state='uploaded')
WHERE EXISTS (
  SELECT 1 FROM board_hosted_adoption_ledger_before_record_identity
  WHERE local_kind='claim' AND local_id=board_claim.id AND state='uploaded');
CREATE INDEX board_claim_project_subject
  ON board_claim(project, subject_kind, subject_value, closed_at);
CREATE INDEX board_claim_run ON board_claim(run_id, closed_at);
CREATE INDEX board_claim_superseded ON board_claim(superseded_by_claim_id);
CREATE UNIQUE INDEX board_claim_record_id_unique ON board_claim(record_id);
--> statement-breakpoint
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
  note_record_id TEXT,
  note_label TEXT,
  note_pending_error TEXT,
  note_filing_started_at TEXT,
  claim_id INTEGER REFERENCES board_claim(id),
  purpose TEXT CHECK (purpose IS NULL OR purpose IN ('information','request','standing')),
  record_id TEXT NOT NULL,
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
  CHECK (
    kind = 'question' OR
    (note_record_id IS NULL AND note_label IS NULL AND note_pending_error IS NULL
      AND note_filing_started_at IS NULL)
  )
);
INSERT INTO board_message
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
FROM board_message_before_record_identity ORDER BY id;
UPDATE board_message SET record_id=(
  SELECT hosted_id FROM board_hosted_adoption_ledger_before_record_identity
  WHERE local_kind=board_message.kind AND local_id=board_message.id AND state='uploaded')
WHERE EXISTS (
  SELECT 1 FROM board_hosted_adoption_ledger_before_record_identity
  WHERE local_kind=board_message.kind AND local_id=board_message.id AND state='uploaded');
CREATE INDEX board_message_delivery ON board_message(expires_at, withdrawn_at, created_at);
CREATE INDEX board_message_author_rate
  ON board_message(author_kind, author_session, author_run_id, created_at);
CREATE INDEX board_message_thread ON board_message(thread_root_id, created_at, id);
CREATE UNIQUE INDEX board_message_record_id_unique ON board_message(record_id);
--> statement-breakpoint
CREATE TABLE board_message_tag (
  message_id INTEGER NOT NULL REFERENCES board_message(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task','path','topic')),
  value TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('sender','inferred')),
  record_id TEXT NOT NULL,
  PRIMARY KEY (message_id, kind, value, origin)
);
INSERT INTO board_message_tag
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
FROM board_message_tag_before_record_identity ORDER BY message_id,kind,value,origin;
CREATE INDEX board_message_tag_message ON board_message_tag(message_id);
CREATE UNIQUE INDEX board_message_tag_record_id_unique ON board_message_tag(record_id);
--> statement-breakpoint
CREATE TABLE board_receipt (
  message_id INTEGER NOT NULL REFERENCES board_message(id) ON DELETE CASCADE,
  reader_session TEXT NOT NULL,
  audience_at_posting INTEGER NOT NULL CHECK (audience_at_posting IN (0,1)),
  delivered_at TEXT,
  acknowledged_at TEXT,
  record_id TEXT NOT NULL,
  PRIMARY KEY (message_id, reader_session)
);
INSERT INTO board_receipt
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
FROM board_receipt_before_record_identity ORDER BY message_id,reader_session;
CREATE UNIQUE INDEX board_receipt_record_id_unique ON board_receipt(record_id);
--> statement-breakpoint
CREATE TABLE board_hosted_adoption_ledger (
  local_kind TEXT NOT NULL CHECK (local_kind IN ('notice','question','reply','claim')),
  local_id INTEGER NOT NULL,
  hosted_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','uploaded','refused')),
  refusal TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (local_kind,local_id),
  CHECK ((state='refused' AND refusal IS NOT NULL) OR (state<>'refused' AND refusal IS NULL))
);
INSERT INTO board_hosted_adoption_ledger
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
FROM board_hosted_adoption_ledger_before_record_identity ORDER BY local_kind,local_id;
CREATE UNIQUE INDEX board_hosted_adoption_ledger_record_id_unique ON board_hosted_adoption_ledger(record_id);
--> statement-breakpoint
CREATE TABLE board_hosted_adoption_receipt (
  local_message_id INTEGER NOT NULL,
  reader_session TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('uploaded','skipped')),
  refusal TEXT,
  updated_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (local_message_id,reader_session),
  CHECK ((state='skipped' AND refusal IS NOT NULL) OR (state='uploaded' AND refusal IS NULL))
);
INSERT INTO board_hosted_adoption_receipt
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
FROM board_hosted_adoption_receipt_before_record_identity ORDER BY local_message_id,reader_session;
CREATE UNIQUE INDEX board_hosted_adoption_receipt_record_id_unique ON board_hosted_adoption_receipt(record_id);
--> statement-breakpoint
CREATE TABLE board_reach_delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_source TEXT NOT NULL CHECK (message_source IN ('local','hosted')),
  message_id TEXT NOT NULL,
  reader_session TEXT NOT NULL,
  reader_project TEXT NOT NULL,
  delivery_point TEXT NOT NULL CHECK (delivery_point IN ('session-start','after-tool-call','stop','heartbeat-monitor')),
  blocked_stop INTEGER NOT NULL CHECK (blocked_stop IN (0,1)),
  audience TEXT NOT NULL,
  acknowledgement_required INTEGER NOT NULL CHECK (acknowledgement_required IN (0,1)),
  posted_at TEXT NOT NULL,
  expires_at TEXT,
  session_started_at TEXT NOT NULL,
  posting_timing TEXT NOT NULL CHECK (posting_timing IN ('before-session','after-session')),
  concern TEXT NOT NULL CHECK (concern IN ('concerned','not-concerned','unqualified')),
  recorded_at TEXT NOT NULL,
  emission_id TEXT,
  purpose TEXT NOT NULL DEFAULT 'information' CHECK (purpose IN ('information','request','standing')),
  record_id TEXT NOT NULL
);
INSERT INTO board_reach_delivery
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
FROM board_reach_delivery_before_record_identity ORDER BY id;
CREATE INDEX board_reach_delivery_recorded ON board_reach_delivery(recorded_at);
CREATE UNIQUE INDEX board_reach_delivery_emission_message
ON board_reach_delivery(emission_id,message_source,message_id)
WHERE emission_id IS NOT NULL;
CREATE UNIQUE INDEX board_reach_delivery_record_id_unique ON board_reach_delivery(record_id);
--> statement-breakpoint
CREATE TABLE board_reach_recording_failure (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL,
  record_id TEXT NOT NULL
);
INSERT INTO board_reach_recording_failure
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
FROM board_reach_recording_failure_before_record_identity ORDER BY id;
CREATE INDEX board_reach_failure_recorded ON board_reach_recording_failure(recorded_at);
CREATE UNIQUE INDEX board_reach_recording_failure_record_id_unique ON board_reach_recording_failure(record_id);
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name IN (
  'board_message','board_claim','board_reach_delivery','board_reach_recording_failure');
INSERT INTO sqlite_sequence(name,seq) SELECT 'board_message',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM board_message),0)) FROM board_message_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq) SELECT 'board_claim',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM board_claim),0)) FROM board_claim_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq) SELECT 'board_reach_delivery',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM board_reach_delivery),0)) FROM board_reach_delivery_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq) SELECT 'board_reach_recording_failure',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM board_reach_recording_failure),0)) FROM board_reach_recording_failure_sequence_before_record_identity saved;
--> statement-breakpoint
DROP TABLE board_claim_before_record_identity;
DROP TABLE board_message_before_record_identity;
DROP TABLE board_message_tag_before_record_identity;
DROP TABLE board_receipt_before_record_identity;
DROP TABLE board_hosted_adoption_ledger_before_record_identity;
DROP TABLE board_hosted_adoption_receipt_before_record_identity;
DROP TABLE board_reach_delivery_before_record_identity;
DROP TABLE board_reach_recording_failure_before_record_identity;
DROP TABLE board_message_sequence_before_record_identity;
DROP TABLE board_claim_sequence_before_record_identity;
DROP TABLE board_reach_delivery_sequence_before_record_identity;
DROP TABLE board_reach_recording_failure_sequence_before_record_identity;
