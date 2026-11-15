CREATE TABLE question_delivery_without_question_fk_snapshot AS SELECT * FROM question_delivery;
CREATE TABLE run_carried_ruling_without_question_fk_snapshot AS SELECT * FROM run_carried_ruling;
CREATE TABLE operator_notification_without_question_fk_snapshot AS SELECT * FROM operator_notification;
--> statement-breakpoint
DROP TABLE question_delivery;
DROP TABLE run_carried_ruling;
DROP TABLE operator_notification;
--> statement-breakpoint
CREATE TABLE question_delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_record_id TEXT NOT NULL,
  run_record_id TEXT REFERENCES run(record_id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live','resume','retry','record-only')),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered','failed','retired')),
  at TEXT NOT NULL, error TEXT, record_id TEXT NOT NULL UNIQUE
);
INSERT INTO question_delivery
SELECT id,question_record_id,run_record_id,mode,outcome,at,error,record_id
FROM question_delivery_without_question_fk_snapshot;
CREATE TABLE run_carried_ruling (
  record_id TEXT NOT NULL PRIMARY KEY,
  run_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  question_record_id TEXT NOT NULL,
  UNIQUE(run_record_id,question_record_id)
);
INSERT INTO run_carried_ruling
SELECT record_id,run_record_id,question_record_id
FROM run_carried_ruling_without_question_fk_snapshot;
CREATE TABLE operator_notification (
  record_id TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('question','workflow')),
  item_id TEXT, question_record_id TEXT,
  episode TEXT NOT NULL, notified_at TEXT NOT NULL,
  CHECK((kind='question' AND question_record_id IS NOT NULL AND item_id IS NULL) OR (kind='workflow' AND item_id IS NOT NULL AND question_record_id IS NULL))
);
INSERT INTO operator_notification
SELECT record_id,kind,item_id,question_record_id,episode,notified_at
FROM operator_notification_without_question_fk_snapshot;
--> statement-breakpoint
DROP TABLE question_delivery_without_question_fk_snapshot;
DROP TABLE run_carried_ruling_without_question_fk_snapshot;
DROP TABLE operator_notification_without_question_fk_snapshot;
CREATE INDEX question_delivery_run_record_id_idx ON question_delivery(run_record_id);
CREATE INDEX question_delivery_question ON question_delivery(question_record_id,id);
CREATE INDEX run_carried_ruling_question_record_id_idx ON run_carried_ruling(question_record_id);
CREATE INDEX operator_notification_question_record_id_idx ON operator_notification(question_record_id);
CREATE UNIQUE INDEX operator_notification_question_episode ON operator_notification(question_record_id,episode) WHERE kind='question';
CREATE UNIQUE INDEX operator_notification_workflow_episode ON operator_notification(item_id,episode) WHERE kind='workflow';
