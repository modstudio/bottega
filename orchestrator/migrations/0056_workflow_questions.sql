CREATE TABLE question_mutation_audit (
  question_id INTEGER NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('rule','overturn','file')),
  actor_session TEXT,
  at TEXT NOT NULL,
  reason TEXT
);
--> statement-breakpoint
CREATE INDEX question_mutation_audit_question ON question_mutation_audit(question_id,at);
--> statement-breakpoint
-- Child tables of question rebuilt below (stash/delete/restore exactly this list):
--   question_delivery, run_carried_ruling, question_mutation_audit
CREATE TEMP TABLE question_mutation_audit_before_workflow_questions AS SELECT * FROM question_mutation_audit;
--> statement-breakpoint
CREATE TEMP TABLE question_delivery_before_workflow_questions AS SELECT * FROM question_delivery;
--> statement-breakpoint
CREATE TEMP TABLE run_carried_ruling_before_workflow_questions AS SELECT * FROM run_carried_ruling;
--> statement-breakpoint
CREATE TEMP TABLE question_sequence_before_workflow_questions AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='question'),0) seq;
--> statement-breakpoint
DELETE FROM question_delivery;
--> statement-breakpoint
DELETE FROM run_carried_ruling;
--> statement-breakpoint
DELETE FROM question_mutation_audit;
--> statement-breakpoint
CREATE TABLE question_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES run(id) ON DELETE CASCADE,
  workflow_cursor_id INTEGER REFERENCES workflow_cursor(id),
  workflow_key TEXT,
  asked_at TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT,
  recommendation TEXT,
  why TEXT,
  answer TEXT,
  answered_at TEXT,
  answered_by TEXT,
  delivery_pending_at TEXT,
  awaiting_operator_at TEXT,
  relayed_by TEXT,
  asked_via TEXT CHECK (asked_via IN ('live', 'reply', 'workflow')),
  answerer_kind TEXT CHECK (answerer_kind IN ('agent', 'operator', 'eval')),
  answer_channel TEXT,
  overturned_at TEXT,
  overturned_by TEXT,
  overturn_reason TEXT,
  replacement TEXT,
  filed_as TEXT,
  filed_ref TEXT,
  filed_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  CHECK ((run_id IS NOT NULL) <> (workflow_cursor_id IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO question_new (
  id,run_id,asked_at,question,options,recommendation,why,answer,answered_at,answered_by,
  delivery_pending_at,awaiting_operator_at,relayed_by,asked_via,answerer_kind,answer_channel,
  overturned_at,overturned_by,overturn_reason,replacement,filed_as,filed_ref,filed_at
)
SELECT id,run_id,asked_at,question,options,recommendation,why,answer,answered_at,answered_by,
       delivery_pending_at,awaiting_operator_at,relayed_by,asked_via,answerer_kind,answer_channel,
       overturned_at,overturned_by,overturn_reason,replacement,filed_as,filed_ref,filed_at
FROM question;
--> statement-breakpoint
DROP TABLE question;
--> statement-breakpoint
ALTER TABLE question_new RENAME TO question;
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name='question';
--> statement-breakpoint
INSERT INTO sqlite_sequence(name,seq)
SELECT 'question',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM question),0))
FROM question_sequence_before_workflow_questions saved;
--> statement-breakpoint
CREATE INDEX question_open ON question(answered_at) WHERE answered_at IS NULL;
--> statement-breakpoint
CREATE INDEX question_run ON question(run_id);
--> statement-breakpoint
CREATE INDEX question_workflow_cursor ON question(workflow_cursor_id);
--> statement-breakpoint
INSERT INTO question_delivery SELECT * FROM question_delivery_before_workflow_questions;
--> statement-breakpoint
INSERT INTO run_carried_ruling SELECT * FROM run_carried_ruling_before_workflow_questions;
--> statement-breakpoint
INSERT INTO question_mutation_audit SELECT * FROM question_mutation_audit_before_workflow_questions;
--> statement-breakpoint
DROP TABLE question_delivery_before_workflow_questions;
--> statement-breakpoint
DROP TABLE run_carried_ruling_before_workflow_questions;
--> statement-breakpoint
DROP TABLE question_mutation_audit_before_workflow_questions;
--> statement-breakpoint
DROP TABLE question_sequence_before_workflow_questions;
--> statement-breakpoint
-- BACKFILL
INSERT INTO question
  (workflow_cursor_id,workflow_key,asked_at,question,asked_via,awaiting_operator_at)
SELECT id,NULLIF(workflow_key,''),updated_at,question,'workflow',updated_at
FROM workflow_cursor
WHERE state='awaiting-ruling' AND question IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM question q
    WHERE q.workflow_cursor_id=workflow_cursor.id AND q.answered_at IS NULL AND q.closed_at IS NULL
  );
-- /BACKFILL
