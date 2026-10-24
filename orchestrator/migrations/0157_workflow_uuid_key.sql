CREATE TABLE workflow_uuid_snapshot AS SELECT * FROM workflow;
CREATE TABLE workflow_version_uuid_snapshot AS SELECT * FROM workflow_version;
CREATE TABLE workflow_event_uuid_snapshot AS SELECT * FROM workflow_event;
CREATE TABLE workflow_cursor_uuid_snapshot AS SELECT * FROM workflow_cursor;
CREATE TABLE workflow_obligation_uuid_snapshot AS SELECT * FROM workflow_obligation;
CREATE TABLE workflow_step_text_uuid_snapshot AS SELECT * FROM workflow_step_text;
CREATE TABLE step_catalogue_uuid_snapshot AS SELECT * FROM step_catalogue;
CREATE TABLE step_catalogue_version_uuid_snapshot AS SELECT * FROM step_catalogue_version;
CREATE TABLE step_catalogue_event_uuid_snapshot AS SELECT * FROM step_catalogue_event;
CREATE TABLE question_workflow_uuid_snapshot AS SELECT * FROM question;
CREATE TABLE operator_notification_workflow_uuid_snapshot AS SELECT * FROM operator_notification;
--> statement-breakpoint
DROP TABLE operator_notification;
DROP TABLE question;
DROP TABLE workflow_step_text;
DROP TABLE workflow_obligation;
DROP TABLE workflow_cursor;
DROP TABLE workflow_event;
DROP TABLE workflow_version;
DROP TABLE workflow;
DROP TABLE step_catalogue_event;
DROP TABLE step_catalogue_version;
DROP TABLE step_catalogue;
--> statement-breakpoint
CREATE TABLE workflow (
  record_id TEXT NOT NULL PRIMARY KEY, slug TEXT NOT NULL, created_at TEXT NOT NULL,
  space_id TEXT, generation INTEGER NOT NULL DEFAULT 1
);
INSERT INTO workflow SELECT record_id,slug,created_at,space_id,generation FROM workflow_uuid_snapshot
WHERE space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE workflow_version (
  record_id TEXT NOT NULL PRIMARY KEY,
  workflow_record_id TEXT NOT NULL REFERENCES workflow(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  n INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','production','retired')),
  definition TEXT NOT NULL, author TEXT NOT NULL CHECK(length(trim(author))>0),
  reason TEXT NOT NULL CHECK(length(trim(reason))>0), created_at TEXT NOT NULL,
  promoted_at TEXT, retired_at TEXT, space_id TEXT, UNIQUE(workflow_record_id,n)
);
INSERT INTO workflow_version
SELECT v.record_id,(SELECT w.record_id FROM workflow_uuid_snapshot w WHERE w.id=v.workflow_id),v.n,v.status,v.definition,v.author,v.reason,v.created_at,v.promoted_at,v.retired_at,v.space_id
FROM workflow_version_uuid_snapshot v
WHERE v.space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE workflow_event (
  record_id TEXT NOT NULL PRIMARY KEY,
  workflow_version_record_id TEXT NOT NULL REFERENCES workflow_version(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  version_n INTEGER NOT NULL, event TEXT NOT NULL CHECK(event IN ('set','fork','import','promote','retire')),
  author TEXT NOT NULL CHECK(length(trim(author))>0), reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  session_id TEXT, at TEXT NOT NULL, space_id TEXT
);
INSERT INTO workflow_event
SELECT e.record_id,(SELECT v.record_id FROM workflow_version_uuid_snapshot v WHERE v.workflow_id=e.workflow_id AND v.n=e.version_n),e.version_n,e.event,e.author,e.reason,e.session_id,e.at,e.space_id
FROM workflow_event_uuid_snapshot e
WHERE e.space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE step_catalogue (
  record_id TEXT NOT NULL PRIMARY KEY, slug TEXT NOT NULL, created_at TEXT NOT NULL,
  space_id TEXT, generation INTEGER NOT NULL DEFAULT 1
);
INSERT INTO step_catalogue SELECT record_id,slug,created_at,space_id,generation FROM step_catalogue_uuid_snapshot
WHERE space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE step_catalogue_version (
  record_id TEXT NOT NULL PRIMARY KEY,
  catalogue_record_id TEXT NOT NULL REFERENCES step_catalogue(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  n INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','production','retired')),
  definition TEXT NOT NULL, author TEXT NOT NULL CHECK(length(trim(author))>0),
  reason TEXT NOT NULL CHECK(length(trim(reason))>0), created_at TEXT NOT NULL,
  promoted_at TEXT, retired_at TEXT, space_id TEXT, UNIQUE(catalogue_record_id,n)
);
INSERT INTO step_catalogue_version
SELECT v.record_id,(SELECT c.record_id FROM step_catalogue_uuid_snapshot c WHERE c.id=v.catalogue_id),v.n,v.status,v.definition,v.author,v.reason,v.created_at,v.promoted_at,v.retired_at,v.space_id
FROM step_catalogue_version_uuid_snapshot v
WHERE v.space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE step_catalogue_event (
  record_id TEXT NOT NULL PRIMARY KEY,
  catalogue_version_record_id TEXT NOT NULL REFERENCES step_catalogue_version(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  version_n INTEGER NOT NULL, event TEXT NOT NULL CHECK(event IN ('set','fork','import','promote','retire')),
  author TEXT NOT NULL CHECK(length(trim(author))>0), reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  session_id TEXT, at TEXT NOT NULL, space_id TEXT
);
INSERT INTO step_catalogue_event
SELECT e.record_id,(SELECT v.record_id FROM step_catalogue_version_uuid_snapshot v WHERE v.catalogue_id=e.catalogue_id AND v.n=e.version_n),e.version_n,e.event,e.author,e.reason,e.session_id,e.at,e.space_id
FROM step_catalogue_event_uuid_snapshot e
WHERE e.space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
--> statement-breakpoint
CREATE TABLE workflow_cursor (
  record_id TEXT NOT NULL PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
  project TEXT NOT NULL, project_record_id TEXT REFERENCES project(record_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  workflow_slug TEXT NOT NULL, mode_slug TEXT NOT NULL, workflow_key TEXT NOT NULL DEFAULT '',
  instance_id TEXT NOT NULL, session_id TEXT,
  workflow_version_record_id TEXT NOT NULL REFERENCES workflow_version(record_id) ON UPDATE CASCADE,
  catalogue_version_record_id TEXT NOT NULL REFERENCES step_catalogue_version(record_id) ON UPDATE CASCADE,
  args TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal>=0), step_slug TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','awaiting-ruling','done','abandoned')),
  closed TEXT NOT NULL DEFAULT '[]', question TEXT, total_steps INTEGER NOT NULL CHECK(total_steps>0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, autonomy TEXT,
  enforcement TEXT NOT NULL DEFAULT 'note-only' CHECK(enforcement IN ('note-only','floors')),
  UNIQUE(project_record_id,workflow_slug,mode_slug,workflow_key,instance_id)
);
INSERT INTO workflow_cursor
SELECT c.record_id,c.id,c.project,c.project_record_id,c.workflow_slug,c.mode_slug,c.workflow_key,c.instance_id,c.session_id,
 (SELECT v.record_id FROM workflow_version_uuid_snapshot v JOIN workflow_uuid_snapshot w ON w.id=v.workflow_id WHERE w.slug=c.workflow_slug AND w.space_id IS (SELECT value FROM json_each(COALESCE((SELECT value FROM schema_meta WHERE key='record_project_spaces'),'{}')) WHERE key=c.project) AND v.n=c.workflow_version),
 (SELECT v.record_id FROM step_catalogue_version_uuid_snapshot v JOIN step_catalogue_uuid_snapshot s ON s.id=v.catalogue_id WHERE s.slug='shared' AND s.space_id IS (SELECT value FROM json_each(COALESCE((SELECT value FROM schema_meta WHERE key='record_project_spaces'),'{}')) WHERE key=c.project) AND v.n=c.catalogue_version),
 c.args,c.ordinal,c.step_slug,c.state,c.closed,c.question,c.total_steps,c.created_at,c.updated_at,c.autonomy,c.enforcement
FROM workflow_cursor_uuid_snapshot c;
CREATE TABLE workflow_obligation (
  record_id TEXT NOT NULL PRIMARY KEY,
  cursor_record_id TEXT NOT NULL REFERENCES workflow_cursor(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  step_ordinal INTEGER NOT NULL, step_slug TEXT NOT NULL, floor TEXT NOT NULL,
  require_pull_request INTEGER NOT NULL DEFAULT 0 CHECK(require_pull_request IN (0,1)),
  expected_exit_code INTEGER NOT NULL DEFAULT 0, expected_status TEXT NOT NULL DEFAULT 'done',
  floor_deferrable INTEGER NOT NULL DEFAULT 1 CHECK(floor_deferrable IN (0,1)), reason TEXT NOT NULL,
  session_id TEXT, created_at TEXT NOT NULL, satisfied_at TEXT, satisfied_step_ordinal INTEGER,
  satisfied_step_slug TEXT, satisfied_evidence TEXT, abandoned_at TEXT, abandoned_reason TEXT,
  operator_ruling INTEGER NOT NULL DEFAULT 0 CHECK(operator_ruling IN (0,1))
);
INSERT INTO workflow_obligation
SELECT o.record_id,(SELECT c.record_id FROM workflow_cursor_uuid_snapshot c WHERE c.id=o.cursor_id),o.step_ordinal,o.step_slug,o.floor,o.require_pull_request,o.expected_exit_code,o.expected_status,o.floor_deferrable,o.reason,o.session_id,o.created_at,o.satisfied_at,o.satisfied_step_ordinal,o.satisfied_step_slug,o.satisfied_evidence,o.abandoned_at,o.abandoned_reason,o.operator_ruling
FROM workflow_obligation_uuid_snapshot o;
CREATE TABLE workflow_step_text (
  record_id TEXT NOT NULL PRIMARY KEY,
  cursor_record_id TEXT NOT NULL REFERENCES workflow_cursor(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  step_ordinal INTEGER NOT NULL, step_slug TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO workflow_step_text
SELECT t.record_id,(SELECT c.record_id FROM workflow_cursor_uuid_snapshot c WHERE c.id=t.cursor_id),t.step_ordinal,t.step_slug,t.body,t.created_at
FROM workflow_step_text_uuid_snapshot t;
--> statement-breakpoint
CREATE TABLE question (
  record_id TEXT NOT NULL PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
  run_record_id TEXT REFERENCES run(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  workflow_cursor_record_id TEXT REFERENCES workflow_cursor(record_id) ON UPDATE CASCADE ON DELETE SET NULL,
  workflow_key TEXT, asked_at TEXT NOT NULL, question TEXT NOT NULL, options TEXT, recommendation TEXT,
  why TEXT, answer TEXT, answered_at TEXT, answered_by TEXT, delivery_pending_at TEXT,
  awaiting_operator_at TEXT, relayed_by TEXT, asked_via TEXT CHECK(asked_via IN ('live','reply','workflow')),
  answerer_kind TEXT CHECK(answerer_kind IN ('agent','operator','eval')), answer_channel TEXT,
  overturned_at TEXT, overturned_by TEXT, overturn_reason TEXT, replacement TEXT, filed_as TEXT,
  filed_ref TEXT, filed_at TEXT, closed_at TEXT, close_reason TEXT, revision INTEGER NOT NULL DEFAULT 1,
  workflow_step_ordinal INTEGER, workflow_step_slug TEXT, filed_record_id TEXT, filed_label TEXT,
  answer_basis TEXT, CHECK((run_record_id IS NOT NULL) <> (workflow_cursor_record_id IS NOT NULL))
);
INSERT INTO question
SELECT q.record_id,q.number,q.run_record_id,(SELECT c.record_id FROM workflow_cursor_uuid_snapshot c WHERE c.id=q.workflow_cursor_id),q.workflow_key,q.asked_at,q.question,q.options,q.recommendation,q.why,q.answer,q.answered_at,q.answered_by,q.delivery_pending_at,q.awaiting_operator_at,q.relayed_by,q.asked_via,q.answerer_kind,q.answer_channel,q.overturned_at,q.overturned_by,q.overturn_reason,q.replacement,q.filed_as,q.filed_ref,q.filed_at,q.closed_at,q.close_reason,q.revision,q.workflow_step_ordinal,q.workflow_step_slug,q.filed_record_id,q.filed_label,q.answer_basis
FROM question_workflow_uuid_snapshot q;
CREATE TABLE operator_notification (
  record_id TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('question','workflow')),
  item_id TEXT, question_record_id TEXT REFERENCES question(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  episode TEXT NOT NULL, notified_at TEXT NOT NULL,
  CHECK((kind='question' AND question_record_id IS NOT NULL AND item_id IS NULL) OR (kind='workflow' AND item_id IS NOT NULL AND question_record_id IS NULL))
);
INSERT INTO operator_notification
SELECT n.record_id,n.kind,CASE WHEN n.kind='workflow' THEN (SELECT c.record_id FROM workflow_cursor_uuid_snapshot c WHERE c.id=n.item_id) END,n.question_record_id,n.episode,n.notified_at
FROM operator_notification_workflow_uuid_snapshot n;
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_local_key ON workflow(slug) WHERE space_id IS NULL;
CREATE UNIQUE INDEX workflow_hosted_key ON workflow(space_id,slug) WHERE space_id IS NOT NULL;
CREATE INDEX workflow_version_workflow_record_id ON workflow_version(workflow_record_id,n);
CREATE UNIQUE INDEX workflow_version_production ON workflow_version(workflow_record_id) WHERE status='production';
CREATE INDEX workflow_event_version ON workflow_event(workflow_version_record_id,version_n);
CREATE UNIQUE INDEX step_catalogue_local_key ON step_catalogue(slug) WHERE space_id IS NULL;
CREATE UNIQUE INDEX step_catalogue_hosted_key ON step_catalogue(space_id,slug) WHERE space_id IS NOT NULL;
CREATE INDEX step_catalogue_version_catalogue_record_id ON step_catalogue_version(catalogue_record_id,n);
CREATE UNIQUE INDEX step_catalogue_version_production ON step_catalogue_version(catalogue_record_id) WHERE status='production';
CREATE INDEX step_catalogue_event_version ON step_catalogue_event(catalogue_version_record_id,version_n);
CREATE INDEX workflow_cursor_session ON workflow_cursor(session_id,state);
CREATE INDEX workflow_cursor_workflow_version ON workflow_cursor(workflow_version_record_id);
CREATE INDEX workflow_cursor_catalogue_version ON workflow_cursor(catalogue_version_record_id);
CREATE INDEX workflow_cursor_project ON workflow_cursor(project_record_id,state);
CREATE INDEX workflow_obligation_open ON workflow_obligation(cursor_record_id,satisfied_at);
CREATE INDEX workflow_step_text_cursor ON workflow_step_text(cursor_record_id,step_ordinal);
CREATE INDEX question_run ON question(run_record_id);
CREATE INDEX question_workflow_cursor ON question(workflow_cursor_record_id);
CREATE INDEX operator_notification_question_record_id_idx ON operator_notification(question_record_id);
CREATE UNIQUE INDEX operator_notification_question_episode ON operator_notification(question_record_id,episode) WHERE kind='question';
CREATE UNIQUE INDEX operator_notification_workflow_episode ON operator_notification(item_id,episode) WHERE kind='workflow';
--> statement-breakpoint
DROP TABLE workflow_uuid_snapshot;
DROP TABLE workflow_version_uuid_snapshot;
DROP TABLE workflow_event_uuid_snapshot;
DROP TABLE workflow_cursor_uuid_snapshot;
DROP TABLE workflow_obligation_uuid_snapshot;
DROP TABLE workflow_step_text_uuid_snapshot;
DROP TABLE step_catalogue_uuid_snapshot;
DROP TABLE step_catalogue_version_uuid_snapshot;
DROP TABLE step_catalogue_event_uuid_snapshot;
DROP TABLE question_workflow_uuid_snapshot;
DROP TABLE operator_notification_workflow_uuid_snapshot;
