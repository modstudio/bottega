PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
-- newRecordId() is the runtime minter; these are migration-only random UUID-v4 values.
CREATE TEMP TABLE workflow_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='workflow'),0) seq;
CREATE TEMP TABLE workflow_version_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='workflow_version'),0) seq;
CREATE TEMP TABLE workflow_event_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='workflow_event'),0) seq;
CREATE TEMP TABLE workflow_obligation_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='workflow_obligation'),0) seq;
CREATE TEMP TABLE workflow_step_text_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='workflow_step_text'),0) seq;
CREATE TEMP TABLE step_catalogue_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='step_catalogue'),0) seq;
CREATE TEMP TABLE step_catalogue_version_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='step_catalogue_version'),0) seq;
CREATE TEMP TABLE step_catalogue_event_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='step_catalogue_event'),0) seq;
CREATE TEMP TABLE lens_revision_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='lens_revision'),0) seq;
CREATE TEMP TABLE lens_profile_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='lens_profile'),0) seq;
CREATE TEMP TABLE lens_profile_revision_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='lens_profile_revision'),0) seq;
CREATE TEMP TABLE project_lens_profile_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='project_lens_profile'),0) seq;
CREATE TEMP TABLE project_lens_profile_revision_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='project_lens_profile_revision'),0) seq;
CREATE TEMP TABLE port_pair_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='port_pair'),0) seq;
CREATE TEMP TABLE port_ref_source_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='port_ref_source'),0) seq;
CREATE TEMP TABLE port_skip_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='port_skip'),0) seq;
--> statement-breakpoint
CREATE TEMP TABLE workflow_before_record_identity AS SELECT * FROM workflow;
CREATE TEMP TABLE workflow_version_before_record_identity AS SELECT * FROM workflow_version;
CREATE TEMP TABLE workflow_event_before_record_identity AS SELECT * FROM workflow_event;
CREATE TEMP TABLE workflow_cursor_before_record_identity AS SELECT * FROM workflow_cursor;
CREATE TEMP TABLE workflow_obligation_before_record_identity AS SELECT * FROM workflow_obligation;
CREATE TEMP TABLE workflow_step_text_before_record_identity AS SELECT * FROM workflow_step_text;
CREATE TEMP TABLE step_catalogue_before_record_identity AS SELECT * FROM step_catalogue;
CREATE TEMP TABLE step_catalogue_version_before_record_identity AS SELECT * FROM step_catalogue_version;
CREATE TEMP TABLE step_catalogue_event_before_record_identity AS SELECT * FROM step_catalogue_event;
CREATE TEMP TABLE lens_before_record_identity AS SELECT * FROM lens;
CREATE TEMP TABLE lens_revision_before_record_identity AS SELECT * FROM lens_revision;
CREATE TEMP TABLE lens_profile_before_record_identity AS SELECT * FROM lens_profile;
CREATE TEMP TABLE lens_profile_revision_before_record_identity AS SELECT * FROM lens_profile_revision;
CREATE TEMP TABLE project_lens_profile_before_record_identity AS SELECT * FROM project_lens_profile;
CREATE TEMP TABLE project_lens_profile_revision_before_record_identity AS SELECT * FROM project_lens_profile_revision;
CREATE TEMP TABLE port_pair_before_record_identity AS SELECT * FROM port_pair;
CREATE TEMP TABLE port_baseline_before_record_identity AS SELECT * FROM port_baseline;
CREATE TEMP TABLE port_doctrine_before_record_identity AS SELECT * FROM port_doctrine;
CREATE TEMP TABLE port_ref_before_record_identity AS SELECT * FROM port_ref;
CREATE TEMP TABLE port_ref_source_before_record_identity AS SELECT * FROM port_ref_source;
CREATE TEMP TABLE port_skip_before_record_identity AS SELECT * FROM port_skip;
CREATE TEMP TABLE question_before_record_identity AS SELECT * FROM question;
CREATE TEMP TABLE question_delivery_before_record_identity AS SELECT * FROM question_delivery;
CREATE TEMP TABLE question_mutation_audit_before_record_identity AS SELECT * FROM question_mutation_audit;
CREATE TEMP TABLE run_carried_ruling_before_record_identity AS SELECT * FROM run_carried_ruling;
--> statement-breakpoint
DELETE FROM question_delivery;
DELETE FROM question_mutation_audit;
DELETE FROM run_carried_ruling;
DELETE FROM question;
DELETE FROM workflow_event;
DELETE FROM workflow_version;
DELETE FROM workflow;
DELETE FROM workflow_step_text;
DELETE FROM workflow_obligation;
DELETE FROM workflow_cursor;
DELETE FROM step_catalogue_event;
DELETE FROM step_catalogue_version;
DELETE FROM step_catalogue;
DELETE FROM lens_profile_revision;
DELETE FROM lens_revision;
DELETE FROM project_lens_profile_revision;
DELETE FROM lens_profile;
DELETE FROM project_lens_profile;
DELETE FROM lens;
DELETE FROM port_ref_source;
DELETE FROM port_skip;
DELETE FROM port_baseline;
DELETE FROM port_ref;
DELETE FROM port_pair;
DELETE FROM port_doctrine;
--> statement-breakpoint
CREATE TABLE workflow_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO workflow_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM workflow_before_record_identity ORDER BY id;
DROP TABLE workflow;
ALTER TABLE workflow_record_identity RENAME TO workflow;
--> statement-breakpoint
CREATE TABLE workflow_version_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','production','retired')),
  definition TEXT NOT NULL,
  author TEXT NOT NULL CHECK (length(trim(author)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at TEXT NOT NULL,
  promoted_at TEXT,
  retired_at TEXT,
  record_id TEXT NOT NULL,
  UNIQUE(workflow_id, n)
);
--> statement-breakpoint
INSERT INTO workflow_version_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM workflow_version_before_record_identity ORDER BY id;
DROP TABLE workflow_version;
ALTER TABLE workflow_version_record_identity RENAME TO workflow_version;
--> statement-breakpoint
CREATE TABLE workflow_event_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  version_n INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('set','fork','import','promote','retire')),
  author TEXT NOT NULL CHECK (length(trim(author)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  FOREIGN KEY(workflow_id, version_n) REFERENCES workflow_version(workflow_id, n)
);
--> statement-breakpoint
INSERT INTO workflow_event_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM workflow_event_before_record_identity ORDER BY id;
DROP TABLE workflow_event;
ALTER TABLE workflow_event_record_identity RENAME TO workflow_event;
--> statement-breakpoint
CREATE TABLE step_catalogue_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO step_catalogue_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM step_catalogue_before_record_identity ORDER BY id;
DROP TABLE step_catalogue;
ALTER TABLE step_catalogue_record_identity RENAME TO step_catalogue;
--> statement-breakpoint
CREATE TABLE step_catalogue_version_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalogue_id INTEGER NOT NULL REFERENCES step_catalogue(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','production','retired')),
  definition TEXT NOT NULL,
  author TEXT NOT NULL CHECK (length(trim(author)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at TEXT NOT NULL,
  promoted_at TEXT,
  retired_at TEXT,
  record_id TEXT NOT NULL,
  UNIQUE(catalogue_id, n)
);
--> statement-breakpoint
INSERT INTO step_catalogue_version_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM step_catalogue_version_before_record_identity ORDER BY id;
DROP TABLE step_catalogue_version;
ALTER TABLE step_catalogue_version_record_identity RENAME TO step_catalogue_version;
--> statement-breakpoint
CREATE TABLE step_catalogue_event_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalogue_id INTEGER NOT NULL REFERENCES step_catalogue(id) ON DELETE CASCADE,
  version_n INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('set','fork','import','promote','retire')),
  author TEXT NOT NULL CHECK (length(trim(author)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  FOREIGN KEY(catalogue_id, version_n) REFERENCES step_catalogue_version(catalogue_id, n)
);
--> statement-breakpoint
INSERT INTO step_catalogue_event_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM step_catalogue_event_before_record_identity ORDER BY id;
DROP TABLE step_catalogue_event;
ALTER TABLE step_catalogue_event_record_identity RENAME TO step_catalogue_event;
--> statement-breakpoint
CREATE TABLE lens_record_identity (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  excludes TEXT NOT NULL,
  slots TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  requires_execution INTEGER NOT NULL DEFAULT 0 CHECK(requires_execution IN (0,1)),
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO lens_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM lens_before_record_identity ORDER BY id;
DROP TABLE lens;
ALTER TABLE lens_record_identity RENAME TO lens;
--> statement-breakpoint
CREATE TABLE lens_revision_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lens_id TEXT NOT NULL REFERENCES lens(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  prior_body TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  UNIQUE(lens_id, version)
);
--> statement-breakpoint
INSERT INTO lens_revision_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM lens_revision_before_record_identity ORDER BY id;
DROP TABLE lens_revision;
ALTER TABLE lens_revision_record_identity RENAME TO lens_revision;
--> statement-breakpoint
CREATE TABLE lens_profile_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lens_id TEXT NOT NULL REFERENCES lens(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK(axis IN ('framework','architecture')),
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  record_id TEXT NOT NULL,
  UNIQUE(lens_id, axis, name)
);
--> statement-breakpoint
INSERT INTO lens_profile_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM lens_profile_before_record_identity ORDER BY id;
DROP TABLE lens_profile;
ALTER TABLE lens_profile_record_identity RENAME TO lens_profile;
--> statement-breakpoint
CREATE TABLE lens_profile_revision_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES lens_profile(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  prior_body TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  UNIQUE(profile_id, version)
);
--> statement-breakpoint
INSERT INTO lens_profile_revision_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM lens_profile_revision_before_record_identity ORDER BY id;
DROP TABLE lens_profile_revision;
ALTER TABLE lens_profile_revision_record_identity RENAME TO lens_profile_revision;
--> statement-breakpoint
CREATE TABLE project_lens_profile_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  lens_id TEXT REFERENCES lens(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK(axis IN ('framework','architecture')),
  profile_name TEXT NOT NULL,
  selected_version INTEGER CHECK(selected_version IS NULL OR selected_version > 0),
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO project_lens_profile_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM project_lens_profile_before_record_identity ORDER BY id;
DROP TABLE project_lens_profile;
ALTER TABLE project_lens_profile_record_identity RENAME TO project_lens_profile;
--> statement-breakpoint
CREATE TABLE project_lens_profile_revision_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  selection_id INTEGER NOT NULL REFERENCES project_lens_profile(id) ON DELETE CASCADE,
  prior_profile_name TEXT,
  prior_selected_version INTEGER CHECK(prior_selected_version IS NULL OR prior_selected_version > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO project_lens_profile_revision_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM project_lens_profile_revision_before_record_identity ORDER BY id;
DROP TABLE project_lens_profile_revision;
ALTER TABLE project_lens_profile_revision_record_identity RENAME TO project_lens_profile_revision;
--> statement-breakpoint
CREATE TABLE port_pair_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  target_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  CHECK (source_project_id <> target_project_id),
  UNIQUE (source_project_id, target_project_id)
);
--> statement-breakpoint
INSERT INTO port_pair_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM port_pair_before_record_identity ORDER BY id;
DROP TABLE port_pair;
ALTER TABLE port_pair_record_identity RENAME TO port_pair;
--> statement-breakpoint
CREATE TABLE port_baseline_record_identity (
  pair_id INTEGER PRIMARY KEY REFERENCES port_pair(id) ON DELETE CASCADE,
  source_commit TEXT,
  scanned_at TEXT,
  record_id TEXT NOT NULL,
  CHECK ((source_commit IS NULL) = (scanned_at IS NULL))
);
--> statement-breakpoint
INSERT INTO port_baseline_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM port_baseline_before_record_identity ORDER BY pair_id;
DROP TABLE port_baseline;
ALTER TABLE port_baseline_record_identity RENAME TO port_baseline;
--> statement-breakpoint
CREATE TABLE port_doctrine_record_identity (
  number INTEGER PRIMARY KEY CHECK (number > 0),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO port_doctrine_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM port_doctrine_before_record_identity ORDER BY number;
DROP TABLE port_doctrine;
ALTER TABLE port_doctrine_record_identity RENAME TO port_doctrine;
--> statement-breakpoint
CREATE TABLE port_ref_record_identity (
  task_key TEXT NOT NULL,
  target_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  record_id TEXT NOT NULL,
  PRIMARY KEY (target_project_id, task_key)
);
--> statement-breakpoint
INSERT INTO port_ref_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM port_ref_before_record_identity ORDER BY target_project_id, task_key;
DROP TABLE port_ref;
ALTER TABLE port_ref_record_identity RENAME TO port_ref;
--> statement-breakpoint
CREATE TABLE port_ref_source_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL,
  target_project_id INTEGER NOT NULL,
  source_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  commits TEXT NOT NULL,
  paths TEXT NOT NULL,
  note TEXT NOT NULL,
  record_id TEXT NOT NULL,
  FOREIGN KEY (target_project_id, task_key)
    REFERENCES port_ref(target_project_id, task_key) ON DELETE CASCADE,
  UNIQUE (target_project_id, task_key, source_project_id)
);
--> statement-breakpoint
INSERT INTO port_ref_source_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM port_ref_source_before_record_identity ORDER BY id;
DROP TABLE port_ref_source;
ALTER TABLE port_ref_source_record_identity RENAME TO port_ref_source;
--> statement-breakpoint
CREATE TABLE port_skip_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id INTEGER NOT NULL REFERENCES port_pair(id) ON DELETE CASCADE,
  candidate TEXT NOT NULL,
  reason TEXT NOT NULL,
  skipped_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  UNIQUE (pair_id, candidate)
);
--> statement-breakpoint
INSERT INTO port_skip_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM port_skip_before_record_identity ORDER BY id;
DROP TABLE port_skip;
ALTER TABLE port_skip_record_identity RENAME TO port_skip;
--> statement-breakpoint
CREATE TABLE workflow_cursor_record_identity (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  workflow_slug TEXT NOT NULL,
  mode_slug TEXT NOT NULL,
  workflow_key TEXT NOT NULL DEFAULT '',
  instance_id TEXT NOT NULL,
  session_id TEXT,
  workflow_version INTEGER NOT NULL,
  catalogue_version INTEGER NOT NULL,
  args TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  step_slug TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','awaiting-ruling','done','abandoned')),
  closed TEXT NOT NULL DEFAULT '[]',
  question TEXT,
  total_steps INTEGER NOT NULL CHECK (total_steps > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  autonomy TEXT,
  enforcement TEXT NOT NULL DEFAULT 'note-only'
    CHECK (enforcement IN ('note-only','floors')),
  record_id TEXT NOT NULL,
  UNIQUE (project, workflow_slug, mode_slug, workflow_key, instance_id)
);
--> statement-breakpoint
INSERT INTO workflow_cursor_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM workflow_cursor_before_record_identity ORDER BY id;
DROP TABLE workflow_cursor;
ALTER TABLE workflow_cursor_record_identity RENAME TO workflow_cursor;
--> statement-breakpoint
CREATE TABLE workflow_obligation_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cursor_id INTEGER NOT NULL REFERENCES workflow_cursor(id),
  step_ordinal INTEGER NOT NULL,
  step_slug TEXT NOT NULL,
  floor TEXT NOT NULL,
  require_pull_request INTEGER NOT NULL DEFAULT 0 CHECK (require_pull_request IN (0,1)),
  expected_exit_code INTEGER NOT NULL DEFAULT 0,
  expected_status TEXT NOT NULL DEFAULT 'done',
  floor_deferrable INTEGER NOT NULL DEFAULT 1 CHECK (floor_deferrable IN (0,1)),
  reason TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL,
  satisfied_at TEXT,
  satisfied_step_ordinal INTEGER,
  satisfied_step_slug TEXT,
  satisfied_evidence TEXT,
  abandoned_at TEXT,
  abandoned_reason TEXT,
  operator_ruling INTEGER NOT NULL DEFAULT 0 CHECK (operator_ruling IN (0,1)),
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO workflow_obligation_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM workflow_obligation_before_record_identity ORDER BY id;
DROP TABLE workflow_obligation;
ALTER TABLE workflow_obligation_record_identity RENAME TO workflow_obligation;
--> statement-breakpoint
CREATE TABLE workflow_step_text_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cursor_id INTEGER NOT NULL REFERENCES workflow_cursor(id) ON DELETE CASCADE,
  step_ordinal INTEGER NOT NULL,
  step_slug TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO workflow_step_text_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM workflow_step_text_before_record_identity ORDER BY id;
DROP TABLE workflow_step_text;
ALTER TABLE workflow_step_text_record_identity RENAME TO workflow_step_text;
--> statement-breakpoint
INSERT INTO question SELECT * FROM question_before_record_identity;
INSERT INTO question_delivery SELECT * FROM question_delivery_before_record_identity;
INSERT INTO question_mutation_audit SELECT * FROM question_mutation_audit_before_record_identity;
INSERT INTO run_carried_ruling SELECT * FROM run_carried_ruling_before_record_identity;
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_record_id_unique ON workflow(record_id);
CREATE UNIQUE INDEX workflow_one_production
  ON workflow_version(workflow_id) WHERE status = 'production';
CREATE INDEX workflow_version_workflow ON workflow_version(workflow_id, n);
CREATE UNIQUE INDEX workflow_version_record_id_unique ON workflow_version(record_id);
CREATE INDEX workflow_event_version ON workflow_event(workflow_id, version_n, id);
CREATE UNIQUE INDEX workflow_event_record_id_unique ON workflow_event(record_id);
CREATE INDEX workflow_cursor_open_session
  ON workflow_cursor(session_id, project, state);
CREATE UNIQUE INDEX workflow_cursor_record_id_unique ON workflow_cursor(record_id);
CREATE INDEX workflow_obligation_open ON workflow_obligation(cursor_id, satisfied_at);
CREATE UNIQUE INDEX workflow_obligation_record_id_unique ON workflow_obligation(record_id);
CREATE INDEX workflow_step_text_cursor_step
  ON workflow_step_text(cursor_id,step_ordinal,id);
CREATE UNIQUE INDEX workflow_step_text_record_id_unique ON workflow_step_text(record_id);
CREATE UNIQUE INDEX step_catalogue_record_id_unique ON step_catalogue(record_id);
CREATE UNIQUE INDEX step_catalogue_one_production
  ON step_catalogue_version(catalogue_id) WHERE status = 'production';
CREATE INDEX step_catalogue_version_catalogue ON step_catalogue_version(catalogue_id, n);
CREATE UNIQUE INDEX step_catalogue_version_record_id_unique ON step_catalogue_version(record_id);
CREATE INDEX step_catalogue_event_version ON step_catalogue_event(catalogue_id, version_n, id);
CREATE UNIQUE INDEX step_catalogue_event_record_id_unique ON step_catalogue_event(record_id);
CREATE UNIQUE INDEX lens_record_id_unique ON lens(record_id);
CREATE UNIQUE INDEX lens_revision_record_id_unique ON lens_revision(record_id);
CREATE UNIQUE INDEX lens_profile_record_id_unique ON lens_profile(record_id);
CREATE UNIQUE INDEX lens_profile_revision_record_id_unique ON lens_profile_revision(record_id);
CREATE UNIQUE INDEX project_lens_profile_specific
  ON project_lens_profile(project_id,lens_id,axis) WHERE lens_id IS NOT NULL;
CREATE UNIQUE INDEX project_lens_profile_global
  ON project_lens_profile(project_id,axis) WHERE lens_id IS NULL;
CREATE UNIQUE INDEX project_lens_profile_record_id_unique ON project_lens_profile(record_id);
CREATE UNIQUE INDEX project_lens_profile_revision_record_id_unique ON project_lens_profile_revision(record_id);
CREATE INDEX port_pair_target ON port_pair(target_project_id);
CREATE UNIQUE INDEX port_pair_record_id_unique ON port_pair(record_id);
CREATE UNIQUE INDEX port_baseline_record_id_unique ON port_baseline(record_id);
CREATE UNIQUE INDEX port_doctrine_record_id_unique ON port_doctrine(record_id);
CREATE UNIQUE INDEX port_ref_record_id_unique ON port_ref(record_id);
CREATE INDEX port_ref_source_task ON port_ref_source(target_project_id,task_key);
CREATE UNIQUE INDEX port_ref_source_record_id_unique ON port_ref_source(record_id);
CREATE INDEX port_skip_pair ON port_skip(pair_id);
CREATE UNIQUE INDEX port_skip_record_id_unique ON port_skip(record_id);
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name IN (
  'workflow','workflow_version','workflow_event','workflow_obligation','workflow_step_text',
  'step_catalogue','step_catalogue_version','step_catalogue_event',
  'lens_revision','lens_profile','lens_profile_revision',
  'project_lens_profile','project_lens_profile_revision',
  'port_pair','port_ref_source','port_skip'
);
INSERT INTO sqlite_sequence(name,seq)
SELECT 'workflow',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM workflow),0))
FROM workflow_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'workflow_version',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM workflow_version),0))
FROM workflow_version_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'workflow_event',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM workflow_event),0))
FROM workflow_event_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'workflow_obligation',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM workflow_obligation),0))
FROM workflow_obligation_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'workflow_step_text',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM workflow_step_text),0))
FROM workflow_step_text_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'step_catalogue',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM step_catalogue),0))
FROM step_catalogue_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'step_catalogue_version',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM step_catalogue_version),0))
FROM step_catalogue_version_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'step_catalogue_event',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM step_catalogue_event),0))
FROM step_catalogue_event_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'lens_revision',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM lens_revision),0))
FROM lens_revision_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'lens_profile',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM lens_profile),0))
FROM lens_profile_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'lens_profile_revision',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM lens_profile_revision),0))
FROM lens_profile_revision_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'project_lens_profile',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM project_lens_profile),0))
FROM project_lens_profile_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'project_lens_profile_revision',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM project_lens_profile_revision),0))
FROM project_lens_profile_revision_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'port_pair',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM port_pair),0))
FROM port_pair_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'port_ref_source',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM port_ref_source),0))
FROM port_ref_source_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'port_skip',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM port_skip),0))
FROM port_skip_sequence_before_record_identity saved;
--> statement-breakpoint
DROP TABLE workflow_before_record_identity;
DROP TABLE workflow_version_before_record_identity;
DROP TABLE workflow_event_before_record_identity;
DROP TABLE workflow_cursor_before_record_identity;
DROP TABLE workflow_obligation_before_record_identity;
DROP TABLE workflow_step_text_before_record_identity;
DROP TABLE step_catalogue_before_record_identity;
DROP TABLE step_catalogue_version_before_record_identity;
DROP TABLE step_catalogue_event_before_record_identity;
DROP TABLE lens_before_record_identity;
DROP TABLE lens_revision_before_record_identity;
DROP TABLE lens_profile_before_record_identity;
DROP TABLE lens_profile_revision_before_record_identity;
DROP TABLE project_lens_profile_before_record_identity;
DROP TABLE project_lens_profile_revision_before_record_identity;
DROP TABLE port_pair_before_record_identity;
DROP TABLE port_baseline_before_record_identity;
DROP TABLE port_doctrine_before_record_identity;
DROP TABLE port_ref_before_record_identity;
DROP TABLE port_ref_source_before_record_identity;
DROP TABLE port_skip_before_record_identity;
DROP TABLE question_before_record_identity;
DROP TABLE question_delivery_before_record_identity;
DROP TABLE question_mutation_audit_before_record_identity;
DROP TABLE run_carried_ruling_before_record_identity;
DROP TABLE workflow_sequence_before_record_identity;
DROP TABLE workflow_version_sequence_before_record_identity;
DROP TABLE workflow_event_sequence_before_record_identity;
DROP TABLE workflow_obligation_sequence_before_record_identity;
DROP TABLE workflow_step_text_sequence_before_record_identity;
DROP TABLE step_catalogue_sequence_before_record_identity;
DROP TABLE step_catalogue_version_sequence_before_record_identity;
DROP TABLE step_catalogue_event_sequence_before_record_identity;
DROP TABLE lens_revision_sequence_before_record_identity;
DROP TABLE lens_profile_sequence_before_record_identity;
DROP TABLE lens_profile_revision_sequence_before_record_identity;
DROP TABLE project_lens_profile_sequence_before_record_identity;
DROP TABLE project_lens_profile_revision_sequence_before_record_identity;
DROP TABLE port_pair_sequence_before_record_identity;
DROP TABLE port_ref_source_sequence_before_record_identity;
DROP TABLE port_skip_sequence_before_record_identity;
