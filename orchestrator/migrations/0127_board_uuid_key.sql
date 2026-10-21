CREATE TABLE board_claim_board_uuid_snapshot AS SELECT * FROM board_claim;
CREATE TABLE board_message_board_uuid_snapshot AS SELECT * FROM board_message;
CREATE TABLE board_message_tag_board_uuid_snapshot AS SELECT * FROM board_message_tag;
CREATE TABLE board_receipt_board_uuid_snapshot AS SELECT * FROM board_receipt;
CREATE TABLE board_reach_delivery_board_uuid_snapshot AS SELECT * FROM board_reach_delivery;
CREATE TABLE board_reach_recording_failure_board_uuid_snapshot AS SELECT * FROM board_reach_recording_failure;
CREATE TEMP TABLE board_message_sequence_board_uuid AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='board_message'),0) seq;
--> statement-breakpoint
DROP TABLE board_message_tag;
DROP TABLE board_receipt;
DROP TABLE board_message;
DROP TABLE board_claim;
DROP TABLE board_reach_delivery;
DROP TABLE board_reach_recording_failure;
--> statement-breakpoint
CREATE TABLE board_claim (
  record_id TEXT NOT NULL PRIMARY KEY, project TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('task','path','resource')), subject_value TEXT NOT NULL,
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('operator','architect')), holder_session TEXT, note TEXT,
  run_record_id TEXT REFERENCES run(record_id), duration_ms INTEGER NOT NULL, taken_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL, lapses_at TEXT NOT NULL, closed_at TEXT,
  close_reason TEXT CHECK (close_reason IN ('released','lapsed','run-ended','task-closed','taken-over')),
  superseded_by_claim_record_id TEXT REFERENCES board_claim(record_id),
  CHECK ((holder_kind='operator' AND holder_session IS NULL) OR (holder_kind='architect' AND holder_session IS NOT NULL)),
  CHECK ((closed_at IS NULL AND close_reason IS NULL) OR (closed_at IS NOT NULL AND close_reason IS NOT NULL))
);
INSERT INTO board_claim SELECT c.record_id,c.project,c.project_record_id,c.subject_kind,c.subject_value,
 c.holder_kind,c.holder_session,c.note,c.run_record_id,c.duration_ms,c.taken_at,c.renewed_at,c.lapses_at,
 c.closed_at,c.close_reason,(SELECT parent.record_id FROM board_claim_board_uuid_snapshot parent WHERE parent.id=c.superseded_by_claim_id)
FROM board_claim_board_uuid_snapshot c;
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
  CHECK ((kind='reply' AND thread_root_record_id IS NOT NULL AND audience IS NULL AND title IS NULL AND ack_required=0 AND ack_deadline IS NULL AND expires_at IS NULL) OR
         (kind<>'reply' AND thread_root_record_id IS NULL AND audience IS NOT NULL AND title IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK ((accepted_reply_record_id IS NULL AND accepted_by IS NULL AND accepted_at IS NULL) OR
         (kind='question' AND accepted_reply_record_id IS NOT NULL AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK (kind='question' OR (note_record_id IS NULL AND note_label IS NULL AND note_pending_error IS NULL AND note_filing_started_at IS NULL))
);
INSERT INTO board_message SELECT m.record_id,m.id,m.kind,m.author_kind,m.author_session,m.author_run_record_id,
 m.audience,m.title,m.body,m.ack_required,m.ack_deadline,m.expires_at,m.created_at,m.withdrawn_at,m.author_harness,
 m.author_project,(SELECT parent.record_id FROM board_message_board_uuid_snapshot parent WHERE parent.id=m.thread_root_id),
 (SELECT reply.record_id FROM board_message_board_uuid_snapshot reply WHERE reply.id=m.accepted_reply_id),m.accepted_by,
 m.accepted_at,m.note_record_id,m.note_label,m.note_pending_error,m.note_filing_started_at,
 (SELECT claim.record_id FROM board_claim_board_uuid_snapshot claim WHERE claim.id=m.claim_id),
 m.purpose,m.author_project_record_id FROM board_message_board_uuid_snapshot m;
INSERT INTO entity_number_counter(record_id,entity,last_number)
SELECT '00000000-0000-4000-8000-000000000127','board_message',
 MAX((SELECT seq FROM board_message_sequence_board_uuid),COALESCE(MAX(id),0))
FROM board_message_board_uuid_snapshot;
--> statement-breakpoint
CREATE TABLE board_message_tag (
  record_id TEXT NOT NULL PRIMARY KEY,
  message_record_id TEXT NOT NULL REFERENCES board_message(record_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task','path','topic')), value TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('sender','inferred')),
  UNIQUE(message_record_id,kind,value,origin)
);
INSERT INTO board_message_tag SELECT t.record_id,
 (SELECT m.record_id FROM board_message_board_uuid_snapshot m WHERE m.id=t.message_id),t.kind,t.value,t.origin
FROM board_message_tag_board_uuid_snapshot t;
CREATE TABLE board_receipt (
  record_id TEXT NOT NULL PRIMARY KEY,
  message_record_id TEXT NOT NULL REFERENCES board_message(record_id) ON DELETE CASCADE,
  reader_session TEXT NOT NULL, audience_at_posting INTEGER NOT NULL CHECK (audience_at_posting IN (0,1)),
  delivered_at TEXT, acknowledged_at TEXT, UNIQUE(message_record_id,reader_session)
);
INSERT INTO board_receipt SELECT r.record_id,
 (SELECT m.record_id FROM board_message_board_uuid_snapshot m WHERE m.id=r.message_id),r.reader_session,
 r.audience_at_posting,r.delivered_at,r.acknowledged_at FROM board_receipt_board_uuid_snapshot r;
--> statement-breakpoint
CREATE TABLE board_reach_delivery (
  record_id TEXT NOT NULL PRIMARY KEY,
  message_source TEXT NOT NULL CHECK (message_source IN ('local','hosted')),
  message_record_id TEXT NOT NULL, reader_session TEXT NOT NULL, reader_project TEXT NOT NULL,
  delivery_point TEXT NOT NULL CHECK (delivery_point IN ('session-start','after-tool-call','stop','heartbeat-monitor')),
  blocked_stop INTEGER NOT NULL CHECK (blocked_stop IN (0,1)), audience TEXT NOT NULL,
  acknowledgement_required INTEGER NOT NULL CHECK (acknowledgement_required IN (0,1)), posted_at TEXT NOT NULL,
  expires_at TEXT, session_started_at TEXT NOT NULL,
  posting_timing TEXT NOT NULL CHECK (posting_timing IN ('before-session','after-session')),
  concern TEXT NOT NULL CHECK (concern IN ('concerned','not-concerned','unqualified')), recorded_at TEXT NOT NULL,
  emission_id TEXT, purpose TEXT NOT NULL DEFAULT 'information' CHECK (purpose IN ('information','request','standing'))
);
INSERT INTO board_reach_delivery SELECT d.record_id,d.message_source,
 CASE WHEN d.message_source='local' THEN (SELECT m.record_id FROM board_message_board_uuid_snapshot m WHERE m.id=CAST(d.message_id AS INTEGER)) ELSE d.message_id END,
 d.reader_session,d.reader_project,d.delivery_point,d.blocked_stop,d.audience,d.acknowledgement_required,
 d.posted_at,d.expires_at,d.session_started_at,d.posting_timing,d.concern,d.recorded_at,d.emission_id,d.purpose
FROM board_reach_delivery_board_uuid_snapshot d;
CREATE TABLE board_reach_recording_failure (record_id TEXT NOT NULL PRIMARY KEY, recorded_at TEXT NOT NULL);
INSERT INTO board_reach_recording_failure SELECT record_id,recorded_at FROM board_reach_recording_failure_board_uuid_snapshot;
--> statement-breakpoint
CREATE INDEX board_claim_project_subject ON board_claim(project_record_id,subject_kind,subject_value,closed_at);
CREATE INDEX board_claim_run ON board_claim(run_record_id,closed_at);
CREATE INDEX board_claim_superseded ON board_claim(superseded_by_claim_record_id);
CREATE INDEX board_claim_project_record_id ON board_claim(project_record_id);
CREATE INDEX board_message_author_project_record_id ON board_message(author_project_record_id);
CREATE INDEX board_message_author_rate ON board_message(author_kind,author_session,author_run_record_id,created_at);
CREATE INDEX board_message_delivery ON board_message(expires_at,withdrawn_at,created_at);
CREATE INDEX board_message_thread ON board_message(thread_root_record_id,created_at,number);
CREATE INDEX board_message_accepted_reply ON board_message(accepted_reply_record_id);
CREATE INDEX board_message_claim ON board_message(claim_record_id);
CREATE INDEX board_message_author_run ON board_message(author_run_record_id);
CREATE INDEX board_message_tag_message ON board_message_tag(message_record_id);
CREATE INDEX board_receipt_message ON board_receipt(message_record_id);
CREATE INDEX board_reach_delivery_recorded ON board_reach_delivery(recorded_at);
CREATE INDEX board_reach_delivery_message ON board_reach_delivery(message_record_id);
CREATE UNIQUE INDEX board_reach_delivery_emission_message
ON board_reach_delivery(emission_id,message_source,message_record_id) WHERE emission_id IS NOT NULL;
CREATE INDEX board_reach_failure_recorded ON board_reach_recording_failure(recorded_at);
--> statement-breakpoint
DROP TABLE board_claim_board_uuid_snapshot;
DROP TABLE board_message_board_uuid_snapshot;
DROP TABLE board_message_tag_board_uuid_snapshot;
DROP TABLE board_receipt_board_uuid_snapshot;
DROP TABLE board_reach_delivery_board_uuid_snapshot;
DROP TABLE board_reach_recording_failure_board_uuid_snapshot;
DROP TABLE board_message_sequence_board_uuid;
