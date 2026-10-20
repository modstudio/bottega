CREATE TABLE lens_uuid_snapshot AS SELECT * FROM lens;
CREATE TABLE lens_revision_uuid_snapshot AS SELECT * FROM lens_revision;
CREATE TABLE lens_profile_uuid_snapshot AS SELECT * FROM lens_profile;
CREATE TABLE lens_profile_revision_uuid_snapshot AS SELECT * FROM lens_profile_revision;
CREATE TABLE project_lens_profile_uuid_snapshot AS SELECT * FROM project_lens_profile;
CREATE TABLE project_lens_profile_revision_uuid_snapshot AS SELECT * FROM project_lens_profile_revision;
CREATE TABLE port_pair_uuid_snapshot AS SELECT * FROM port_pair;
CREATE TABLE port_baseline_uuid_snapshot AS SELECT * FROM port_baseline;
CREATE TABLE port_doctrine_uuid_snapshot AS SELECT * FROM port_doctrine;
CREATE TABLE port_ref_uuid_snapshot AS SELECT * FROM port_ref;
CREATE TABLE port_ref_source_uuid_snapshot AS SELECT * FROM port_ref_source;
CREATE TABLE port_skip_uuid_snapshot AS SELECT * FROM port_skip;
--> statement-breakpoint
DROP TABLE project_lens_profile_revision;
DROP TABLE project_lens_profile;
DROP TABLE lens_profile_revision;
DROP TABLE lens_profile;
DROP TABLE lens_revision;
DROP TABLE lens;
DROP TABLE port_ref_source;
DROP TABLE port_ref;
DROP TABLE port_skip;
DROP TABLE port_baseline;
DROP TABLE port_pair;
DROP TABLE port_doctrine;
--> statement-breakpoint
CREATE TABLE lens (
  record_id TEXT NOT NULL PRIMARY KEY,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  excludes TEXT NOT NULL,
  slots TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  requires_execution INTEGER NOT NULL DEFAULT 0 CHECK(requires_execution IN (0,1)),
  space_id TEXT
);
INSERT INTO lens SELECT record_id,id,title,question,excludes,slots,version,enabled,requires_execution,space_id FROM lens_uuid_snapshot
WHERE space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE lens_revision (
  record_id TEXT NOT NULL PRIMARY KEY,
  lens_record_id TEXT NOT NULL REFERENCES lens(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  version INTEGER NOT NULL,
  prior_body TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  space_id TEXT
);
INSERT INTO lens_revision
SELECT r.record_id,(SELECT l.record_id FROM lens_uuid_snapshot l WHERE l.id=r.lens_id AND l.space_id IS r.space_id),r.version,r.prior_body,r.reason,r.session_id,r.at,r.space_id
FROM lens_revision_uuid_snapshot r WHERE r.space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE lens_profile (
  record_id TEXT NOT NULL PRIMARY KEY,
  lens_record_id TEXT NOT NULL REFERENCES lens(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK(axis IN ('framework','architecture')),
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  space_id TEXT
);
INSERT INTO lens_profile
SELECT p.record_id,(SELECT l.record_id FROM lens_uuid_snapshot l WHERE l.id=p.lens_id AND l.space_id IS p.space_id),p.axis,p.name,p.version,p.body,p.enabled,p.space_id
FROM lens_profile_uuid_snapshot p WHERE p.space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE lens_profile_revision (
  record_id TEXT NOT NULL PRIMARY KEY,
  profile_record_id TEXT NOT NULL REFERENCES lens_profile(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  version INTEGER NOT NULL,
  prior_body TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  space_id TEXT
);
INSERT INTO lens_profile_revision
SELECT r.record_id,(SELECT p.record_id FROM lens_profile_uuid_snapshot p WHERE p.id=r.profile_id),r.version,r.prior_body,r.reason,r.session_id,r.at,r.space_id
FROM lens_profile_revision_uuid_snapshot r WHERE r.space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE project_lens_profile (
  record_id TEXT NOT NULL PRIMARY KEY,
  project_record_id TEXT NOT NULL,
  lens_record_id TEXT REFERENCES lens(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK(axis IN ('framework','architecture')),
  profile_name TEXT NOT NULL,
  selected_version INTEGER CHECK(selected_version IS NULL OR selected_version > 0),
  selection_version INTEGER NOT NULL DEFAULT 1 CHECK(selection_version > 0),
  space_id TEXT
);
INSERT INTO project_lens_profile
SELECT s.record_id,s.project_record_id,(SELECT l.record_id FROM lens_uuid_snapshot l WHERE l.id=s.lens_id AND l.space_id IS s.space_id),s.axis,s.profile_name,s.selected_version,s.selection_version,s.space_id
FROM project_lens_profile_uuid_snapshot s WHERE s.space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE project_lens_profile_revision (
  record_id TEXT NOT NULL PRIMARY KEY,
  selection_record_id TEXT NOT NULL REFERENCES project_lens_profile(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  prior_profile_name TEXT,
  prior_selected_version INTEGER CHECK(prior_selected_version IS NULL OR prior_selected_version > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  space_id TEXT
);
INSERT INTO project_lens_profile_revision
SELECT r.record_id,(SELECT s.record_id FROM project_lens_profile_uuid_snapshot s WHERE s.id=r.selection_id),r.prior_profile_name,r.prior_selected_version,r.reason,r.session_id,r.at,r.space_id
FROM project_lens_profile_revision_uuid_snapshot r WHERE r.space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
--> statement-breakpoint
CREATE TABLE port_pair (
  record_id TEXT NOT NULL PRIMARY KEY,
  source_project_record_id TEXT NOT NULL,
  target_project_record_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  space_id TEXT,
  CHECK(source_project_record_id <> target_project_record_id)
);
INSERT INTO port_pair SELECT record_id,source_project_record_id,target_project_record_id,created_at,space_id FROM port_pair_uuid_snapshot
WHERE space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE port_baseline (
  pair_record_id TEXT NOT NULL PRIMARY KEY REFERENCES port_pair(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  source_commit TEXT,
  scanned_at TEXT,
  record_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  space_id TEXT,
  CHECK((source_commit IS NULL) = (scanned_at IS NULL))
);
INSERT INTO port_baseline
SELECT (SELECT p.record_id FROM port_pair_uuid_snapshot p WHERE p.id=b.pair_id),b.source_commit,b.scanned_at,b.record_id,b.version,b.space_id
FROM port_baseline_uuid_snapshot b WHERE b.space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE port_doctrine (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER NOT NULL CHECK(number > 0),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  space_id TEXT
);
INSERT INTO port_doctrine SELECT record_id,number,title,body,created_at,retired_at,version,space_id FROM port_doctrine_uuid_snapshot
WHERE space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE port_ref (
  record_id TEXT NOT NULL PRIMARY KEY,
  task_key TEXT NOT NULL,
  target_project_record_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  space_id TEXT
);
INSERT INTO port_ref SELECT record_id,task_key,target_project_record_id,note,created_at,resolved_at,version,space_id FROM port_ref_uuid_snapshot
WHERE space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE port_ref_source (
  record_id TEXT NOT NULL PRIMARY KEY,
  ref_record_id TEXT NOT NULL REFERENCES port_ref(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  source_project_record_id TEXT NOT NULL,
  commits TEXT NOT NULL,
  paths TEXT NOT NULL,
  note TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  space_id TEXT
);
INSERT INTO port_ref_source
SELECT s.record_id,(SELECT r.record_id FROM port_ref_uuid_snapshot r WHERE r.task_key=s.task_key AND r.target_project_record_id=s.target_project_record_id AND r.space_id IS s.space_id),s.source_project_record_id,s.commits,s.paths,s.note,s.id,s.space_id
FROM port_ref_source_uuid_snapshot s WHERE s.space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
CREATE TABLE port_skip (
  record_id TEXT NOT NULL PRIMARY KEY,
  pair_record_id TEXT NOT NULL REFERENCES port_pair(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  candidate TEXT NOT NULL,
  reason TEXT NOT NULL,
  skipped_at TEXT NOT NULL,
  space_id TEXT
);
INSERT INTO port_skip
SELECT s.record_id,(SELECT p.record_id FROM port_pair_uuid_snapshot p WHERE p.id=s.pair_id),s.candidate,s.reason,s.skipped_at,s.space_id
FROM port_skip_uuid_snapshot s WHERE s.space_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
--> statement-breakpoint
DELETE FROM project_lens_profile_revision WHERE space_id IS NULL AND EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
DELETE FROM project_lens_profile WHERE space_id IS NULL AND EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
DELETE FROM lens_profile_revision WHERE space_id IS NULL AND EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
DELETE FROM lens_profile WHERE space_id IS NULL AND EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
DELETE FROM lens_revision WHERE space_id IS NULL AND EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
DELETE FROM lens WHERE space_id IS NULL AND EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
DELETE FROM port_ref_source WHERE space_id IS NULL AND EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
DELETE FROM port_ref WHERE space_id IS NULL AND EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
DELETE FROM port_skip WHERE space_id IS NULL AND EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
DELETE FROM port_baseline WHERE space_id IS NULL AND EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
DELETE FROM port_pair WHERE space_id IS NULL AND EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
DELETE FROM port_doctrine WHERE space_id IS NULL AND EXISTS (SELECT 1 FROM record_install_binding WHERE id=1);
--> statement-breakpoint
CREATE UNIQUE INDEX lens_local_key ON lens(id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX lens_hosted_key ON lens(space_id,id) WHERE space_id IS NOT NULL;
CREATE INDEX lens_revision_lens_record_id ON lens_revision(lens_record_id,version);
CREATE UNIQUE INDEX lens_revision_local_version ON lens_revision(lens_record_id,version) WHERE space_id IS NULL;
CREATE UNIQUE INDEX lens_revision_hosted_version ON lens_revision(space_id,lens_record_id,version) WHERE space_id IS NOT NULL;
CREATE INDEX lens_profile_lens_record_id ON lens_profile(lens_record_id,axis,name);
CREATE INDEX lens_profile_space_lens_record_id ON lens_profile(space_id,lens_record_id,axis,name);
CREATE UNIQUE INDEX lens_profile_local_key ON lens_profile(lens_record_id,axis,name) WHERE space_id IS NULL;
CREATE UNIQUE INDEX lens_profile_hosted_key ON lens_profile(space_id,lens_record_id,axis,name) WHERE space_id IS NOT NULL;
CREATE INDEX lens_profile_revision_profile_record_id ON lens_profile_revision(profile_record_id,version);
CREATE UNIQUE INDEX lens_profile_revision_local_version ON lens_profile_revision(profile_record_id,version) WHERE space_id IS NULL;
CREATE UNIQUE INDEX lens_profile_revision_hosted_version ON lens_profile_revision(space_id,profile_record_id,version) WHERE space_id IS NOT NULL;
CREATE INDEX project_lens_profile_lens_record_id ON project_lens_profile(lens_record_id);
CREATE INDEX project_lens_profile_space_project ON project_lens_profile(space_id,project_record_id,lens_record_id,axis);
CREATE UNIQUE INDEX project_lens_profile_local_global ON project_lens_profile(project_record_id,axis) WHERE space_id IS NULL AND lens_record_id IS NULL;
CREATE UNIQUE INDEX project_lens_profile_local_specific ON project_lens_profile(project_record_id,lens_record_id,axis) WHERE space_id IS NULL AND lens_record_id IS NOT NULL;
CREATE UNIQUE INDEX project_lens_profile_hosted_global ON project_lens_profile(space_id,project_record_id,axis) WHERE space_id IS NOT NULL AND lens_record_id IS NULL;
CREATE UNIQUE INDEX project_lens_profile_hosted_specific ON project_lens_profile(space_id,project_record_id,lens_record_id,axis) WHERE space_id IS NOT NULL AND lens_record_id IS NOT NULL;
CREATE INDEX project_lens_profile_revision_selection_record_id ON project_lens_profile_revision(selection_record_id);
CREATE UNIQUE INDEX port_pair_local_key ON port_pair(source_project_record_id,target_project_record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_pair_hosted_key ON port_pair(space_id,source_project_record_id,target_project_record_id) WHERE space_id IS NOT NULL;
CREATE INDEX port_pair_target ON port_pair(target_project_record_id);
CREATE INDEX port_pair_space_projects ON port_pair(space_id,source_project_record_id,target_project_record_id);
CREATE UNIQUE INDEX port_doctrine_local_key ON port_doctrine(number) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_doctrine_hosted_key ON port_doctrine(space_id,number) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_ref_local_key ON port_ref(target_project_record_id,task_key) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_ref_hosted_key ON port_ref(space_id,target_project_record_id,task_key) WHERE space_id IS NOT NULL;
CREATE INDEX port_ref_space_target ON port_ref(space_id,target_project_record_id,task_key);
CREATE INDEX port_ref_source_ref_record_id ON port_ref_source(ref_record_id,position);
CREATE UNIQUE INDEX port_ref_source_local_key ON port_ref_source(ref_record_id,source_project_record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_ref_source_hosted_key ON port_ref_source(space_id,ref_record_id,source_project_record_id) WHERE space_id IS NOT NULL;
CREATE INDEX port_skip_pair_record_id ON port_skip(pair_record_id);
CREATE UNIQUE INDEX port_skip_local_key ON port_skip(pair_record_id,candidate) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_skip_hosted_key ON port_skip(space_id,pair_record_id,candidate) WHERE space_id IS NOT NULL;
--> statement-breakpoint
DROP TABLE lens_uuid_snapshot;
DROP TABLE lens_revision_uuid_snapshot;
DROP TABLE lens_profile_uuid_snapshot;
DROP TABLE lens_profile_revision_uuid_snapshot;
DROP TABLE project_lens_profile_uuid_snapshot;
DROP TABLE project_lens_profile_revision_uuid_snapshot;
DROP TABLE port_pair_uuid_snapshot;
DROP TABLE port_baseline_uuid_snapshot;
DROP TABLE port_doctrine_uuid_snapshot;
DROP TABLE port_ref_uuid_snapshot;
DROP TABLE port_ref_source_uuid_snapshot;
DROP TABLE port_skip_uuid_snapshot;
