CREATE TABLE question_question_uuid (
  record_id TEXT NOT NULL PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
  run_record_id TEXT REFERENCES run(record_id) ON DELETE CASCADE,
  workflow_cursor_id INTEGER REFERENCES workflow_cursor(id), workflow_key TEXT, asked_at TEXT NOT NULL,
  question TEXT NOT NULL, options TEXT, recommendation TEXT, why TEXT, answer TEXT, answered_at TEXT,
  answered_by TEXT, delivery_pending_at TEXT, awaiting_operator_at TEXT, relayed_by TEXT,
  asked_via TEXT CHECK (asked_via IN ('live','reply','workflow')),
  answerer_kind TEXT CHECK (answerer_kind IN ('agent','operator','eval')), answer_channel TEXT,
  overturned_at TEXT, overturned_by TEXT, overturn_reason TEXT, replacement TEXT, filed_as TEXT,
  filed_ref TEXT, filed_at TEXT, closed_at TEXT, close_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1, workflow_step_ordinal INTEGER, workflow_step_slug TEXT,
  filed_record_id TEXT, filed_label TEXT, answer_basis TEXT,
  CHECK ((run_record_id IS NOT NULL) <> (workflow_cursor_id IS NOT NULL))
);
INSERT INTO question_question_uuid SELECT record_id,id,run_record_id,workflow_cursor_id,workflow_key,
 asked_at,question,options,recommendation,why,answer,answered_at,answered_by,delivery_pending_at,
 awaiting_operator_at,relayed_by,asked_via,answerer_kind,answer_channel,overturned_at,overturned_by,
 overturn_reason,replacement,filed_as,filed_ref,filed_at,closed_at,close_reason,revision,
 workflow_step_ordinal,workflow_step_slug,filed_record_id,filed_label,answer_basis FROM question ORDER BY id;
CREATE TABLE entity_number_counter (
  record_id TEXT NOT NULL PRIMARY KEY,entity TEXT NOT NULL UNIQUE,
  last_number INTEGER NOT NULL CHECK(last_number >= 0)
);
INSERT INTO entity_number_counter SELECT record_id,'run',last_number FROM run_number_counter;
INSERT INTO entity_number_counter
SELECT '00000000-0000-4000-8000-000000000125','question',
 MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='question'),0),COALESCE(MAX(id),0)) FROM question;
--> statement-breakpoint
CREATE TABLE question_delivery_question_uuid_snapshot AS SELECT * FROM question_delivery;
CREATE TABLE question_mutation_audit_question_uuid_snapshot AS SELECT * FROM question_mutation_audit;
CREATE TABLE run_carried_ruling_question_uuid_snapshot AS SELECT * FROM run_carried_ruling;
CREATE TABLE operator_notification_question_uuid_snapshot AS SELECT * FROM operator_notification;
DROP TABLE operator_notification;
DROP TABLE run_carried_ruling;
DROP TABLE question_mutation_audit;
DROP TABLE question_delivery;
DROP TABLE question;
DROP TABLE run_number_counter;
ALTER TABLE question_question_uuid RENAME TO question;
CREATE TABLE question_delivery_question_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_record_id TEXT NOT NULL REFERENCES question(record_id) ON DELETE CASCADE,
  run_record_id TEXT REFERENCES run(record_id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live','resume','retry','record-only')),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered','failed','retired')),
  at TEXT NOT NULL, error TEXT, record_id TEXT NOT NULL UNIQUE
);
INSERT INTO question_delivery_question_uuid SELECT d.id,
 (SELECT q.record_id FROM question q WHERE q.number=d.question_id),
 d.run_record_id,d.mode,d.outcome,d.at,d.error,d.record_id
FROM question_delivery_question_uuid_snapshot d;
DROP TABLE question_delivery_question_uuid_snapshot;
CREATE TABLE question_mutation_audit_question_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  question_record_id TEXT NOT NULL REFERENCES question(record_id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('rule','overturn','file','close')),
  actor_session TEXT, at TEXT NOT NULL, reason TEXT
);
INSERT INTO question_mutation_audit_question_uuid SELECT a.record_id,
 (SELECT q.record_id FROM question q WHERE q.number=a.question_id),
 a.action,a.actor_session,a.at,a.reason
FROM question_mutation_audit_question_uuid_snapshot a;
DROP TABLE question_mutation_audit_question_uuid_snapshot;
CREATE TABLE run_carried_ruling_question_uuid (
  record_id TEXT NOT NULL PRIMARY KEY, run_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  question_record_id TEXT NOT NULL REFERENCES question(record_id) ON DELETE CASCADE,
  UNIQUE(run_record_id,question_record_id)
);
INSERT INTO run_carried_ruling_question_uuid SELECT r.record_id,r.run_record_id,
 (SELECT q.record_id FROM question q WHERE q.number=r.question_id)
FROM run_carried_ruling_question_uuid_snapshot r;
DROP TABLE run_carried_ruling_question_uuid_snapshot;
CREATE TABLE operator_notification_question_uuid (
  record_id TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('question','workflow')),
  item_id INTEGER,question_record_id TEXT REFERENCES question(record_id) ON DELETE CASCADE,
  episode TEXT NOT NULL,notified_at TEXT NOT NULL,
  CHECK ((kind='question' AND question_record_id IS NOT NULL AND item_id IS NULL) OR
         (kind='workflow' AND item_id IS NOT NULL AND question_record_id IS NULL))
);
INSERT INTO operator_notification_question_uuid SELECT n.record_id,n.kind,
 CASE WHEN n.kind='workflow' THEN n.item_id END,
 CASE WHEN n.kind='question' THEN (SELECT q.record_id FROM question q WHERE q.number=n.item_id) END,
 n.episode,n.notified_at FROM operator_notification_question_uuid_snapshot n;
DROP TABLE operator_notification_question_uuid_snapshot;
ALTER TABLE question_delivery_question_uuid RENAME TO question_delivery;
ALTER TABLE question_mutation_audit_question_uuid RENAME TO question_mutation_audit;
ALTER TABLE run_carried_ruling_question_uuid RENAME TO run_carried_ruling;
ALTER TABLE operator_notification_question_uuid RENAME TO operator_notification;
--> statement-breakpoint
CREATE INDEX question_open ON question(answered_at) WHERE answered_at IS NULL;
CREATE INDEX question_run ON question(run_record_id);
CREATE INDEX question_workflow_cursor ON question(workflow_cursor_id);
CREATE INDEX question_delivery_question ON question_delivery(question_record_id,id);
CREATE INDEX question_mutation_audit_question ON question_mutation_audit(question_record_id,at);
CREATE UNIQUE INDEX operator_notification_question_episode ON operator_notification(question_record_id,episode) WHERE kind='question';
CREATE UNIQUE INDEX operator_notification_workflow_episode ON operator_notification(item_id,episode) WHERE kind='workflow';
