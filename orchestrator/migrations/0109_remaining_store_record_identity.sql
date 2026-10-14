PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
-- newRecordId() is the runtime minter; these are migration-only random UUID-v4 values.
CREATE TEMP TABLE monitor_invocation_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='monitor_invocation'),0) seq;
CREATE TEMP TABLE monitor_condition_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='monitor_condition'),0) seq;
CREATE TEMP TABLE probe_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='probe'),0) seq;
CREATE TEMP TABLE run_message_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='run_message'),0) seq;
CREATE TEMP TABLE spawn_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='spawn'),0) seq;
CREATE TEMP TABLE worker_note_request_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='worker_note_request'),0) seq;
--> statement-breakpoint
CREATE TEMP TABLE agent_before_record_identity AS SELECT * FROM agent;
CREATE TEMP TABLE branch_landing_record_before_record_identity AS SELECT * FROM branch_landing_record;
CREATE TEMP TABLE canon_pack_before_record_identity AS SELECT * FROM canon_pack;
CREATE TEMP TABLE doc_related_subject_before_record_identity AS SELECT * FROM doc_related_subject;
CREATE TEMP TABLE metric_before_record_identity AS SELECT * FROM metric;
CREATE TEMP TABLE monitor_condition_before_record_identity AS SELECT * FROM monitor_condition;
CREATE TEMP TABLE monitor_invocation_before_record_identity AS SELECT * FROM monitor_invocation;
CREATE TEMP TABLE operator_notification_before_record_identity AS SELECT * FROM operator_notification;
CREATE TEMP TABLE probe_before_record_identity AS SELECT * FROM probe;
CREATE TEMP TABLE run_message_before_record_identity AS SELECT * FROM run_message;
CREATE TEMP TABLE spawn_before_record_identity AS SELECT * FROM spawn;
CREATE TEMP TABLE worker_note_request_before_record_identity AS SELECT * FROM worker_note_request;
--> statement-breakpoint
DELETE FROM monitor_condition;
DELETE FROM monitor_invocation;
DELETE FROM agent;
DELETE FROM branch_landing_record;
DELETE FROM canon_pack;
DELETE FROM doc_related_subject;
DELETE FROM metric;
DELETE FROM operator_notification;
DELETE FROM probe;
DELETE FROM run_message;
DELETE FROM spawn;
DELETE FROM worker_note_request;
--> statement-breakpoint
CREATE TABLE agent_record_identity (
  name TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  backend TEXT,
  model TEXT NOT NULL,
  base_url TEXT,
  transport TEXT NOT NULL DEFAULT 'cli' CHECK (transport IN ('cli','acp')),
  caps TEXT NOT NULL CHECK (json_valid(caps)),
  billing TEXT NOT NULL CHECK (billing IN ('subscription','free','metered','none','unknown')),
  operated_by TEXT NOT NULL CHECK (operated_by IN ('vendor','self')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  disabled_reason TEXT,
  probed_at TEXT,
  probe_result TEXT CHECK (probe_result IS NULL OR json_valid(probe_result)),
  jobs TEXT CHECK (jobs IS NULL OR json_valid(jobs)),
  preferred_jobs TEXT CHECK (preferred_jobs IS NULL OR json_valid(preferred_jobs)),
  max_concurrent INTEGER CHECK (max_concurrent IS NULL OR max_concurrent > 0),
  record_id TEXT NOT NULL,
  CHECK ((enabled = 1 AND disabled_reason IS NULL) OR
         (enabled = 0 AND length(trim(disabled_reason)) > 0))
);
INSERT INTO agent_record_identity SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) FROM agent_before_record_identity ORDER BY name;
DROP TABLE agent;
ALTER TABLE agent_record_identity RENAME TO agent;
--> statement-breakpoint
CREATE TABLE branch_landing_record_record_identity (
  project TEXT NOT NULL, branch TEXT NOT NULL, tip TEXT NOT NULL,
  pr_number INTEGER NOT NULL CHECK (pr_number > 0), merge_commit TEXT,
  merged_at TEXT NOT NULL, recording_session TEXT, recorded_at TEXT NOT NULL,
  record_id TEXT NOT NULL, PRIMARY KEY (project, branch)
);
INSERT INTO branch_landing_record_record_identity SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) FROM branch_landing_record_before_record_identity ORDER BY project,branch;
DROP TABLE branch_landing_record;
ALTER TABLE branch_landing_record_record_identity RENAME TO branch_landing_record;
--> statement-breakpoint
CREATE TABLE canon_pack_record_identity (
  id INTEGER PRIMARY KEY, job TEXT NOT NULL, project TEXT, sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL, doc_count INTEGER NOT NULL, doc_revisions TEXT NOT NULL,
  compiled_at TEXT NOT NULL, findings INTEGER NOT NULL,
  project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  canon_bytes INTEGER NOT NULL DEFAULT 0, doc_bytes INTEGER NOT NULL DEFAULT 0,
  record_id TEXT NOT NULL, UNIQUE(job, project)
);
INSERT INTO canon_pack_record_identity SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) FROM canon_pack_before_record_identity ORDER BY id;
DROP TABLE canon_pack;
ALTER TABLE canon_pack_record_identity RENAME TO canon_pack;
CREATE UNIQUE INDEX canon_pack_address ON canon_pack(job, COALESCE(project, ''));
CREATE INDEX canon_pack_project_id ON canon_pack(project_id);
--> statement-breakpoint
CREATE TABLE doc_related_subject_record_identity (
  id TEXT PRIMARY KEY, doc_record_id TEXT NOT NULL REFERENCES doc(record_id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES subject(id) ON DELETE RESTRICT, record_id TEXT NOT NULL,
  UNIQUE(doc_record_id, subject_id)
);
INSERT INTO doc_related_subject_record_identity SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) FROM doc_related_subject_before_record_identity ORDER BY id;
DROP TABLE doc_related_subject;
ALTER TABLE doc_related_subject_record_identity RENAME TO doc_related_subject;
CREATE INDEX doc_related_subject_doc ON doc_related_subject(doc_record_id);
CREATE INDEX doc_related_subject_subject ON doc_related_subject(subject_id);
--> statement-breakpoint
CREATE TABLE metric_record_identity (
  day TEXT PRIMARY KEY, claude_tokens INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  messages INTEGER NOT NULL, tasks INTEGER NOT NULL, canon_tokens INTEGER NOT NULL DEFAULT 0,
  other_tokens INTEGER NOT NULL DEFAULT 0, commits INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0, lines_product INTEGER NOT NULL DEFAULT 0,
  lines_test INTEGER NOT NULL DEFAULT 0, lines_docs INTEGER NOT NULL DEFAULT 0,
  lines_config INTEGER NOT NULL DEFAULT 0, lines_generated INTEGER NOT NULL DEFAULT 0,
  collected_at TEXT NOT NULL, record_id TEXT NOT NULL
);
INSERT INTO metric_record_identity SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) FROM metric_before_record_identity ORDER BY day;
DROP TABLE metric;
ALTER TABLE metric_record_identity RENAME TO metric;
--> statement-breakpoint
CREATE TABLE monitor_invocation_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('invoked','backstop')), findings INTEGER,
  errors INTEGER, record_id TEXT NOT NULL
);
INSERT INTO monitor_invocation_record_identity SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) FROM monitor_invocation_before_record_identity ORDER BY id;
DROP TABLE monitor_invocation;
ALTER TABLE monitor_invocation_record_identity RENAME TO monitor_invocation;
--> statement-breakpoint
CREATE TABLE monitor_condition_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id INTEGER NOT NULL REFERENCES monitor_invocation(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, subject TEXT NOT NULL, condition_since TEXT, age_ms INTEGER,
  detail TEXT NOT NULL, action TEXT NOT NULL, issue_key TEXT,
  severity TEXT CHECK (severity IS NULL OR severity IN ('informational','attention')),
  owner_session_id TEXT, delivered_at TEXT, record_id TEXT NOT NULL,
  UNIQUE(invocation_id, kind, subject)
);
INSERT INTO monitor_condition_record_identity SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) FROM monitor_condition_before_record_identity ORDER BY id;
DROP TABLE monitor_condition;
ALTER TABLE monitor_condition_record_identity RENAME TO monitor_condition;
CREATE INDEX monitor_condition_kind ON monitor_condition(kind, invocation_id);
CREATE INDEX monitor_condition_latest ON monitor_condition(owner_session_id, kind, subject, condition_since, id);
CREATE INDEX monitor_condition_owner_delivery ON monitor_condition(owner_session_id, delivered_at);
--> statement-breakpoint
CREATE TABLE operator_notification_record_identity (
  kind TEXT NOT NULL CHECK (kind IN ('question','workflow')), item_id INTEGER NOT NULL,
  episode TEXT NOT NULL, notified_at TEXT NOT NULL, record_id TEXT NOT NULL,
  PRIMARY KEY (kind,item_id,episode)
);
INSERT INTO operator_notification_record_identity SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) FROM operator_notification_before_record_identity ORDER BY kind,item_id,episode;
DROP TABLE operator_notification;
ALTER TABLE operator_notification_record_identity RENAME TO operator_notification;
--> statement-breakpoint
CREATE TABLE probe_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, command TEXT NOT NULL, cwd TEXT NOT NULL,
  head_commit TEXT, exit_code INTEGER NOT NULL, output_tail TEXT NOT NULL,
  withheld INTEGER NOT NULL DEFAULT 0 CHECK (withheld IN (0,1)), session_id TEXT,
  created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'probe'
    CHECK (kind IN ('probe','exec')), record_id TEXT NOT NULL
);
INSERT INTO probe_record_identity SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) FROM probe_before_record_identity ORDER BY id;
DROP TABLE probe;
ALTER TABLE probe_record_identity RENAME TO probe;
--> statement-breakpoint
CREATE TABLE run_message_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL CHECK (direction IN ('to_worker','from_worker')),
  root_run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE, sender_session TEXT,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0), created_at TEXT NOT NULL,
  read_at TEXT, read_by TEXT,
  delivery TEXT NOT NULL CHECK (delivery IN ('architect_cli','worker_tool')),
  record_id TEXT NOT NULL
);
INSERT INTO run_message_record_identity SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) FROM run_message_before_record_identity ORDER BY id;
DROP TABLE run_message;
ALTER TABLE run_message_record_identity RENAME TO run_message;
CREATE INDEX run_message_root ON run_message(root_run_id, id);
CREATE INDEX run_message_unread ON run_message(root_run_id, direction, read_at) WHERE read_at IS NULL;
--> statement-breakpoint
CREATE TABLE spawn_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, session_id TEXT, cwd TEXT,
  event TEXT, subagent_type TEXT, description TEXT, prompt_bytes INTEGER,
  decision TEXT NOT NULL, why TEXT NOT NULL, record_id TEXT NOT NULL
);
INSERT INTO spawn_record_identity SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) FROM spawn_before_record_identity ORDER BY id;
DROP TABLE spawn;
ALTER TABLE spawn_record_identity RENAME TO spawn;
CREATE INDEX spawn_at ON spawn(at);
--> statement-breakpoint
CREATE TABLE worker_note_request_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000 AND instr(text, char(10)) = 0 AND instr(text, char(13)) = 0),
  file TEXT CHECK (file IS NULL OR length(file) BETWEEN 1 AND 1000),
  same_as TEXT CHECK (same_as IS NULL OR length(same_as) BETWEEN 1 AND 1000),
  requested_at TEXT NOT NULL, claimed_at TEXT, finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested','filed','refused')),
  note_record_id TEXT, note_label TEXT,
  candidate_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_ids)),
  candidate_labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_labels)),
  refusal_class TEXT CHECK (refusal_class IN ('anchor-refused','filing-refused','supervisor-closed')),
  detail TEXT, project TEXT, record_id TEXT NOT NULL,
  CHECK (
    (status = 'requested' AND finished_at IS NULL AND note_record_id IS NULL AND note_label IS NULL AND refusal_class IS NULL) OR
    (status = 'filed' AND finished_at IS NOT NULL AND note_label IS NOT NULL AND refusal_class IS NULL) OR
    (status = 'refused' AND finished_at IS NOT NULL AND note_record_id IS NULL AND note_label IS NULL AND refusal_class IS NOT NULL)
  )
);
INSERT INTO worker_note_request_record_identity SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) FROM worker_note_request_before_record_identity ORDER BY id;
DROP TABLE worker_note_request;
ALTER TABLE worker_note_request_record_identity RENAME TO worker_note_request;
CREATE INDEX worker_note_request_pending ON worker_note_request(run_id,status,claimed_at,id);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_record_id_unique ON agent(record_id);
CREATE UNIQUE INDEX branch_landing_record_record_id_unique ON branch_landing_record(record_id);
CREATE UNIQUE INDEX canon_pack_record_id_unique ON canon_pack(record_id);
CREATE UNIQUE INDEX doc_related_subject_record_id_unique ON doc_related_subject(record_id);
CREATE UNIQUE INDEX metric_record_id_unique ON metric(record_id);
CREATE UNIQUE INDEX monitor_condition_record_id_unique ON monitor_condition(record_id);
CREATE UNIQUE INDEX monitor_invocation_record_id_unique ON monitor_invocation(record_id);
CREATE UNIQUE INDEX operator_notification_record_id_unique ON operator_notification(record_id);
CREATE UNIQUE INDEX probe_record_id_unique ON probe(record_id);
CREATE UNIQUE INDEX run_message_record_id_unique ON run_message(record_id);
CREATE UNIQUE INDEX spawn_record_id_unique ON spawn(record_id);
CREATE UNIQUE INDEX worker_note_request_record_id_unique ON worker_note_request(record_id);
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name IN ('monitor_invocation','monitor_condition','probe','run_message','spawn','worker_note_request');
INSERT INTO sqlite_sequence(name,seq) SELECT 'monitor_invocation',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM monitor_invocation),0)) FROM monitor_invocation_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq) SELECT 'monitor_condition',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM monitor_condition),0)) FROM monitor_condition_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq) SELECT 'probe',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM probe),0)) FROM probe_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq) SELECT 'run_message',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM run_message),0)) FROM run_message_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq) SELECT 'spawn',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM spawn),0)) FROM spawn_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq) SELECT 'worker_note_request',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM worker_note_request),0)) FROM worker_note_request_sequence_before_record_identity saved;
--> statement-breakpoint
DROP TABLE agent_before_record_identity;
DROP TABLE branch_landing_record_before_record_identity;
DROP TABLE canon_pack_before_record_identity;
DROP TABLE doc_related_subject_before_record_identity;
DROP TABLE metric_before_record_identity;
DROP TABLE monitor_condition_before_record_identity;
DROP TABLE monitor_invocation_before_record_identity;
DROP TABLE operator_notification_before_record_identity;
DROP TABLE probe_before_record_identity;
DROP TABLE run_message_before_record_identity;
DROP TABLE spawn_before_record_identity;
DROP TABLE worker_note_request_before_record_identity;
DROP TABLE monitor_invocation_sequence_before_record_identity;
DROP TABLE monitor_condition_sequence_before_record_identity;
DROP TABLE probe_sequence_before_record_identity;
DROP TABLE run_message_sequence_before_record_identity;
DROP TABLE spawn_sequence_before_record_identity;
DROP TABLE worker_note_request_sequence_before_record_identity;
