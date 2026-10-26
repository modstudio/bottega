ALTER TABLE question ADD COLUMN run_record_id TEXT;
--> statement-breakpoint
ALTER TABLE question ADD COLUMN root_run_record_id TEXT;
--> statement-breakpoint
ALTER TABLE question_delivery ADD COLUMN run_record_id TEXT;
--> statement-breakpoint
CREATE TEMP TABLE question_run_ref_migration_guard (detail TEXT);
--> statement-breakpoint
CREATE TEMP TRIGGER question_run_ref_migration_refusal
BEFORE INSERT ON question_run_ref_migration_guard
WHEN NEW.detail IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, NEW.detail);
END;
--> statement-breakpoint
INSERT INTO question_run_ref_migration_guard(detail)
SELECT 'unparseable question.run_ref values: ' || group_concat(record_id || ':' || run_ref, ', ')
FROM question
WHERE run_ref IS NOT NULL AND NOT (
  length(run_ref)=83 AND substr(run_ref,1,5)='orch:' AND substr(run_ref,42,6)=':turn:'
  AND substr(run_ref,6,36) NOT GLOB '*[^0-9A-Fa-f-]*'
  AND substr(run_ref,14,1)='-' AND substr(run_ref,19,1)='-'
  AND substr(run_ref,24,1)='-' AND substr(run_ref,29,1)='-'
  AND substr(run_ref,20,1) GLOB '[1-8]' AND substr(run_ref,25,1) GLOB '[89AaBb]'
  AND substr(run_ref,48,36) NOT GLOB '*[^0-9A-Fa-f-]*'
  AND substr(run_ref,56,1)='-' AND substr(run_ref,61,1)='-'
  AND substr(run_ref,66,1)='-' AND substr(run_ref,71,1)='-'
  AND substr(run_ref,62,1) GLOB '[1-8]' AND substr(run_ref,67,1) GLOB '[89AaBb]'
)
HAVING count(*) > 0;
--> statement-breakpoint
INSERT INTO question_run_ref_migration_guard(detail)
SELECT 'unparseable question.root_ref values: ' || group_concat(record_id || ':' || root_ref, ', ')
FROM question
WHERE root_ref IS NOT NULL AND NOT (
  length(root_ref)=41 AND substr(root_ref,1,5)='orch:'
  AND substr(root_ref,6,36) NOT GLOB '*[^0-9A-Fa-f-]*'
  AND substr(root_ref,14,1)='-' AND substr(root_ref,19,1)='-'
  AND substr(root_ref,24,1)='-' AND substr(root_ref,29,1)='-'
  AND substr(root_ref,20,1) GLOB '[1-8]' AND substr(root_ref,25,1) GLOB '[89AaBb]'
)
HAVING count(*) > 0;
--> statement-breakpoint
INSERT INTO question_run_ref_migration_guard(detail)
SELECT 'unparseable question_delivery.run_ref values: ' ||
  group_concat(question_record_id || ':' || run_ref, ', ')
FROM question_delivery
WHERE run_ref IS NOT NULL AND NOT (
  length(run_ref)=83 AND substr(run_ref,1,5)='orch:' AND substr(run_ref,42,6)=':turn:'
  AND substr(run_ref,6,36) NOT GLOB '*[^0-9A-Fa-f-]*'
  AND substr(run_ref,14,1)='-' AND substr(run_ref,19,1)='-'
  AND substr(run_ref,24,1)='-' AND substr(run_ref,29,1)='-'
  AND substr(run_ref,20,1) GLOB '[1-8]' AND substr(run_ref,25,1) GLOB '[89AaBb]'
  AND substr(run_ref,48,36) NOT GLOB '*[^0-9A-Fa-f-]*'
  AND substr(run_ref,56,1)='-' AND substr(run_ref,61,1)='-'
  AND substr(run_ref,66,1)='-' AND substr(run_ref,71,1)='-'
  AND substr(run_ref,62,1) GLOB '[1-8]' AND substr(run_ref,67,1) GLOB '[89AaBb]'
)
HAVING count(*) > 0;
--> statement-breakpoint
UPDATE question SET
  root_run_record_id=substr(root_ref,6,36),
  run_record_id=substr(run_ref,48,36)
WHERE run_ref IS NOT NULL;
--> statement-breakpoint
UPDATE question_delivery SET run_record_id=substr(run_ref,48,36) WHERE run_ref IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER question_run_ref_migration_refusal;
--> statement-breakpoint
DROP TABLE question_run_ref_migration_guard;
--> statement-breakpoint
CREATE TABLE question_run_record_id_snapshot AS SELECT * FROM question;
CREATE TABLE question_delivery_run_record_id_snapshot AS SELECT * FROM question_delivery;
CREATE TABLE operator_waiting_email_run_record_id_snapshot AS SELECT * FROM operator_waiting_email;
DROP TABLE operator_waiting_email;
DROP TABLE question_delivery;
DROP TABLE question;
--> statement-breakpoint
CREATE TABLE question (
  record_id TEXT NOT NULL PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
  run_record_id TEXT, root_run_record_id TEXT,
  workflow_cursor_id TEXT, workflow_key TEXT, project TEXT,
  task_key TEXT, session_id TEXT, asked_at TEXT NOT NULL, answered_at TEXT,
  asked_via TEXT CHECK (asked_via IN ('live','reply','workflow')),
  answerer_kind TEXT CHECK (answerer_kind IN ('agent','operator','eval')),
  answer_channel TEXT CHECK (answer_channel IN ('cli','mcp','ui')),
  overturned_at TEXT, closed_at TEXT, close_reason TEXT, project_record_id TEXT,
  task_record_id TEXT REFERENCES task(record_id) ON UPDATE CASCADE ON DELETE SET NULL,
  workflow_task_record_id TEXT REFERENCES task(record_id) ON UPDATE CASCADE ON DELETE SET NULL,
  CHECK ((run_record_id IS NOT NULL) <> (workflow_cursor_id IS NOT NULL))
);
INSERT INTO question SELECT
  record_id,number,run_record_id,root_run_record_id,
  workflow_cursor_id,workflow_key,project,task_key,session_id,asked_at,answered_at,
  asked_via,answerer_kind,answer_channel,overturned_at,closed_at,close_reason,
  project_record_id,task_record_id,workflow_task_record_id
FROM question_run_record_id_snapshot;
--> statement-breakpoint
CREATE TABLE question_delivery (
  question_record_id TEXT NOT NULL REFERENCES question(record_id) ON DELETE CASCADE,
  run_record_id TEXT, mode TEXT NOT NULL CHECK (mode IN ('live','resume','retry','record-only')),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered','failed','retired')),
  at TEXT NOT NULL, error TEXT
);
INSERT INTO question_delivery SELECT
  question_record_id,run_record_id,mode,outcome,at,error
FROM question_delivery_run_record_id_snapshot;
--> statement-breakpoint
CREATE TABLE operator_waiting_email (
  kind TEXT NOT NULL CHECK (kind IN ('question','workflow')),item_id TEXT,
  question_record_id TEXT REFERENCES question(record_id) ON DELETE CASCADE,
  episode TEXT NOT NULL,pushed_at TEXT NOT NULL,
  CHECK ((kind='question' AND question_record_id IS NOT NULL AND item_id IS NULL) OR
         (kind='workflow' AND item_id IS NOT NULL AND question_record_id IS NULL))
);
INSERT INTO operator_waiting_email SELECT * FROM operator_waiting_email_run_record_id_snapshot;
--> statement-breakpoint
DROP TABLE question_run_record_id_snapshot;
DROP TABLE question_delivery_run_record_id_snapshot;
DROP TABLE operator_waiting_email_run_record_id_snapshot;
CREATE INDEX question_open ON question(answered_at) WHERE answered_at IS NULL;
CREATE INDEX question_root ON question(root_run_record_id);
CREATE INDEX question_workflow_cursor ON question(workflow_cursor_id);
CREATE INDEX question_task_record_id ON question(task_record_id);
CREATE INDEX question_workflow_task_record_id ON question(workflow_task_record_id);
CREATE INDEX question_task_key ON question(task_key);
CREATE INDEX question_workflow_key ON question(workflow_key);
CREATE INDEX question_delivery_question_record_id_idx ON question_delivery(question_record_id);
CREATE INDEX operator_waiting_email_question_record_id_idx ON operator_waiting_email(question_record_id);
CREATE UNIQUE INDEX operator_waiting_email_question_episode ON operator_waiting_email(question_record_id,episode) WHERE kind='question';
CREATE UNIQUE INDEX operator_waiting_email_workflow_episode ON operator_waiting_email(item_id,episode) WHERE kind='workflow';
