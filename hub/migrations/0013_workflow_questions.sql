-- Child tables of question rebuilt below (stash/delete/restore exactly this list):
--   question_delivery
CREATE TEMP TABLE question_delivery_before_workflow_questions AS SELECT * FROM question_delivery;
--> statement-breakpoint
CREATE TEMP TABLE question_sequence_before_workflow_questions AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='question'),0) seq;
--> statement-breakpoint
DELETE FROM question_delivery;
--> statement-breakpoint
CREATE TABLE question_new (
  question_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_ref TEXT,
  root_ref TEXT,
  workflow_cursor_id INTEGER,
  workflow_key TEXT,
  project TEXT,
  task_key TEXT,
  session_id TEXT,
  asked_at TEXT NOT NULL,
  answered_at TEXT,
  asked_via TEXT CHECK (asked_via IN ('live', 'reply', 'workflow')),
  answerer_kind TEXT CHECK (answerer_kind IN ('agent', 'operator', 'eval')),
  answer_channel TEXT CHECK (answer_channel IN ('cli', 'mcp', 'ui')),
  overturned_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  CHECK ((run_ref IS NOT NULL) <> (workflow_cursor_id IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO question_new
  (question_id,run_ref,root_ref,task_key,session_id,asked_at,answered_at,
   asked_via,answerer_kind,answer_channel,overturned_at)
SELECT question_id,run_ref,root_ref,task_key,session_id,asked_at,answered_at,
       asked_via,answerer_kind,answer_channel,overturned_at FROM question;
--> statement-breakpoint
DROP TABLE question;
--> statement-breakpoint
ALTER TABLE question_new RENAME TO question;
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name='question';
--> statement-breakpoint
INSERT INTO sqlite_sequence(name,seq)
SELECT 'question',MAX(saved.seq,COALESCE((SELECT MAX(question_id) FROM question),0))
FROM question_sequence_before_workflow_questions saved;
--> statement-breakpoint
CREATE INDEX question_open ON question(answered_at) WHERE answered_at IS NULL;
--> statement-breakpoint
CREATE INDEX question_root ON question(root_ref);
--> statement-breakpoint
CREATE INDEX question_workflow_cursor ON question(workflow_cursor_id);
--> statement-breakpoint
INSERT INTO question_delivery SELECT * FROM question_delivery_before_workflow_questions;
--> statement-breakpoint
DROP TABLE question_delivery_before_workflow_questions;
--> statement-breakpoint
DROP TABLE question_sequence_before_workflow_questions;
