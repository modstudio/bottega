CREATE TABLE question_cursor_uuid_snapshot AS SELECT * FROM question;
CREATE TABLE question_delivery_cursor_uuid_snapshot AS SELECT * FROM question_delivery;
CREATE TABLE operator_waiting_email_cursor_uuid_snapshot AS SELECT * FROM operator_waiting_email;
DROP TABLE operator_waiting_email;
DROP TABLE question_delivery;
DROP TABLE question;
--> statement-breakpoint
CREATE TABLE question (
  record_id TEXT NOT NULL PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
  run_ref TEXT, root_ref TEXT, workflow_cursor_id TEXT, workflow_key TEXT, project TEXT,
  task_key TEXT, session_id TEXT, asked_at TEXT NOT NULL, answered_at TEXT,
  asked_via TEXT CHECK (asked_via IN ('live','reply','workflow')),
  answerer_kind TEXT CHECK (answerer_kind IN ('agent','operator','eval')),
  answer_channel TEXT CHECK (answer_channel IN ('cli','mcp','ui')),
  overturned_at TEXT, closed_at TEXT, close_reason TEXT, project_record_id TEXT,
  CHECK ((run_ref IS NOT NULL) <> (workflow_cursor_id IS NOT NULL))
);
INSERT INTO question SELECT
 q.record_id,q.number,q.run_ref,q.root_ref,
 (SELECT m.record_id FROM cursor_identity_map_input m WHERE m.number=q.workflow_cursor_id),
 q.workflow_key,q.project,q.task_key,q.session_id,q.asked_at,q.answered_at,q.asked_via,
 q.answerer_kind,q.answer_channel,q.overturned_at,q.closed_at,q.close_reason,q.project_record_id
FROM question_cursor_uuid_snapshot q;
--> statement-breakpoint
CREATE TABLE question_delivery (
  question_record_id TEXT NOT NULL REFERENCES question(record_id) ON DELETE CASCADE,
  run_ref TEXT, mode TEXT NOT NULL CHECK (mode IN ('live','resume','retry','record-only')),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered','failed','retired')),
  at TEXT NOT NULL, error TEXT
);
INSERT INTO question_delivery SELECT * FROM question_delivery_cursor_uuid_snapshot;
--> statement-breakpoint
CREATE TABLE operator_waiting_email (
  kind TEXT NOT NULL CHECK (kind IN ('question','workflow')),item_id TEXT,
  question_record_id TEXT REFERENCES question(record_id) ON DELETE CASCADE,
  episode TEXT NOT NULL,pushed_at TEXT NOT NULL,
  CHECK ((kind='question' AND question_record_id IS NOT NULL AND item_id IS NULL) OR
         (kind='workflow' AND item_id IS NOT NULL AND question_record_id IS NULL))
);
INSERT INTO operator_waiting_email SELECT e.kind,
 CASE WHEN e.kind='workflow' THEN m.record_id END,
 e.question_record_id,e.episode,e.pushed_at
FROM operator_waiting_email_cursor_uuid_snapshot e
LEFT JOIN cursor_identity_map_input m ON e.kind='workflow' AND m.number=e.item_id;
--> statement-breakpoint
DROP TABLE question_cursor_uuid_snapshot;
DROP TABLE question_delivery_cursor_uuid_snapshot;
DROP TABLE operator_waiting_email_cursor_uuid_snapshot;
DROP TABLE cursor_identity_map_input;
CREATE INDEX question_open ON question(answered_at) WHERE answered_at IS NULL;
CREATE INDEX question_root ON question(root_ref);
CREATE INDEX question_workflow_cursor ON question(workflow_cursor_id);
CREATE INDEX question_delivery_question_record_id_idx ON question_delivery(question_record_id);
CREATE INDEX operator_waiting_email_question_record_id_idx ON operator_waiting_email(question_record_id);
CREATE UNIQUE INDEX operator_waiting_email_question_episode ON operator_waiting_email(question_record_id,episode) WHERE kind='question';
CREATE UNIQUE INDEX operator_waiting_email_workflow_episode ON operator_waiting_email(item_id,episode) WHERE kind='workflow';
