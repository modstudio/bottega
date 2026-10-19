CREATE TABLE IF NOT EXISTS question_identity_map_input(
  number INTEGER PRIMARY KEY, record_id TEXT NOT NULL UNIQUE
);
CREATE TABLE question_delivery_question_uuid_snapshot AS SELECT * FROM question_delivery;
CREATE TABLE operator_waiting_email_question_uuid_snapshot AS SELECT * FROM operator_waiting_email;
DROP TABLE operator_waiting_email;
DROP TABLE question_delivery;
--> statement-breakpoint
CREATE TABLE question_question_uuid (
  record_id TEXT NOT NULL PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
  run_ref TEXT, root_ref TEXT, workflow_cursor_id INTEGER, workflow_key TEXT, project TEXT,
  task_key TEXT, session_id TEXT, asked_at TEXT NOT NULL, answered_at TEXT,
  asked_via TEXT CHECK (asked_via IN ('live','reply','workflow')),
  answerer_kind TEXT CHECK (answerer_kind IN ('agent','operator','eval')),
  answer_channel TEXT CHECK (answer_channel IN ('cli','mcp','ui')),
  overturned_at TEXT, closed_at TEXT, close_reason TEXT, project_record_id TEXT,
  CHECK ((run_ref IS NOT NULL) <> (workflow_cursor_id IS NOT NULL))
);
INSERT INTO question_question_uuid SELECT
 (SELECT m.record_id FROM question_identity_map_input m WHERE m.number=q.question_id),
 q.question_id,q.run_ref,q.root_ref,q.workflow_cursor_id,
 q.workflow_key,q.project,q.task_key,q.session_id,q.asked_at,q.answered_at,q.asked_via,q.answerer_kind,
 q.answer_channel,q.overturned_at,q.closed_at,q.close_reason,q.project_record_id
FROM question q ORDER BY q.question_id;
--> statement-breakpoint
DROP TABLE question;
ALTER TABLE question_question_uuid RENAME TO question;
--> statement-breakpoint
CREATE TABLE question_delivery_question_uuid (
  question_record_id TEXT NOT NULL REFERENCES question(record_id) ON DELETE CASCADE,
  run_ref TEXT, mode TEXT NOT NULL CHECK (mode IN ('live','resume','retry','record-only')),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered','failed','retired')),
  at TEXT NOT NULL, error TEXT
);
INSERT INTO question_delivery_question_uuid SELECT
 (SELECT m.record_id FROM question_identity_map_input m WHERE m.number=d.question_id),
 d.run_ref,d.mode,d.outcome,d.at,d.error
FROM question_delivery_question_uuid_snapshot d;
--> statement-breakpoint
CREATE TABLE operator_waiting_email_question_uuid (
  kind TEXT NOT NULL CHECK (kind IN ('question','workflow')),item_id INTEGER,
  question_record_id TEXT REFERENCES question(record_id) ON DELETE CASCADE,
  episode TEXT NOT NULL,pushed_at TEXT NOT NULL,
  CHECK ((kind='question' AND question_record_id IS NOT NULL AND item_id IS NULL) OR
         (kind='workflow' AND item_id IS NOT NULL AND question_record_id IS NULL))
);
INSERT INTO operator_waiting_email_question_uuid SELECT e.kind,
 CASE WHEN e.kind='workflow' THEN e.item_id END,
 CASE WHEN e.kind='question' THEN m.record_id END,e.episode,e.pushed_at
FROM operator_waiting_email_question_uuid_snapshot e
LEFT JOIN question_identity_map_input m ON e.kind='question' AND m.number=e.item_id;
--> statement-breakpoint
ALTER TABLE question_delivery_question_uuid RENAME TO question_delivery;
ALTER TABLE operator_waiting_email_question_uuid RENAME TO operator_waiting_email;
DROP TABLE question_delivery_question_uuid_snapshot;
DROP TABLE operator_waiting_email_question_uuid_snapshot;
DROP TABLE question_identity_map_input;
--> statement-breakpoint
CREATE INDEX question_open ON question(answered_at) WHERE answered_at IS NULL;
CREATE INDEX question_root ON question(root_ref);
CREATE INDEX question_workflow_cursor ON question(workflow_cursor_id);
CREATE UNIQUE INDEX operator_waiting_email_question_episode ON operator_waiting_email(question_record_id,episode) WHERE kind='question';
CREATE UNIQUE INDEX operator_waiting_email_workflow_episode ON operator_waiting_email(item_id,episode) WHERE kind='workflow';
