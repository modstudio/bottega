PRAGMA foreign_keys=OFF;
CREATE TABLE project_lens_profile_without_project_parent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_record_id TEXT NOT NULL,
  lens_id TEXT,
  axis TEXT NOT NULL CHECK(axis IN ('framework','architecture')),
  profile_name TEXT NOT NULL,
  selected_version INTEGER CHECK(selected_version IS NULL OR selected_version > 0),
  record_id TEXT NOT NULL,
  selection_version INTEGER NOT NULL DEFAULT 1 CHECK(selection_version > 0),
  space_id TEXT
);
INSERT INTO project_lens_profile_without_project_parent
  (id,project_record_id,lens_id,axis,profile_name,selected_version,record_id,selection_version,space_id)
SELECT id,project_record_id,lens_id,axis,profile_name,selected_version,record_id,selection_version,space_id
FROM project_lens_profile;
--> statement-breakpoint
CREATE TABLE project_lens_profile_revision_without_project_parent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  selection_id INTEGER NOT NULL REFERENCES project_lens_profile_without_project_parent(id) ON DELETE CASCADE,
  prior_profile_name TEXT,
  prior_selected_version INTEGER CHECK(prior_selected_version IS NULL OR prior_selected_version > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  space_id TEXT
);
INSERT INTO project_lens_profile_revision_without_project_parent
  (id,selection_id,prior_profile_name,prior_selected_version,reason,session_id,at,record_id,space_id)
SELECT id,selection_id,prior_profile_name,prior_selected_version,reason,session_id,at,record_id,space_id
FROM project_lens_profile_revision;
--> statement-breakpoint
CREATE TABLE port_pair_without_project_parent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_project_record_id TEXT NOT NULL,
  target_project_record_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  space_id TEXT,
  CHECK(source_project_record_id <> target_project_record_id)
);
INSERT INTO port_pair_without_project_parent
  (id,source_project_record_id,target_project_record_id,created_at,record_id,space_id)
SELECT id,source_project_record_id,target_project_record_id,created_at,record_id,space_id
FROM port_pair;
--> statement-breakpoint
CREATE TABLE port_baseline_without_project_parent (
  pair_id INTEGER PRIMARY KEY REFERENCES port_pair_without_project_parent(id) ON DELETE CASCADE,
  source_commit TEXT,
  scanned_at TEXT,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  space_id TEXT,
  CHECK((source_commit IS NULL) = (scanned_at IS NULL))
);
INSERT INTO port_baseline_without_project_parent
  (pair_id,source_commit,scanned_at,record_id,version,space_id)
SELECT pair_id,source_commit,scanned_at,record_id,version,space_id
FROM port_baseline;
--> statement-breakpoint
CREATE TABLE port_skip_without_project_parent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id INTEGER NOT NULL REFERENCES port_pair_without_project_parent(id) ON DELETE CASCADE,
  candidate TEXT NOT NULL,
  reason TEXT NOT NULL,
  skipped_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  space_id TEXT
);
INSERT INTO port_skip_without_project_parent
  (id,pair_id,candidate,reason,skipped_at,record_id,space_id)
SELECT id,pair_id,candidate,reason,skipped_at,record_id,space_id
FROM port_skip;
--> statement-breakpoint
CREATE TABLE port_ref_without_project_parent (
  task_key TEXT NOT NULL,
  target_project_record_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  space_id TEXT,
  UNIQUE(space_id,target_project_record_id,task_key)
);
INSERT INTO port_ref_without_project_parent
  (task_key,target_project_record_id,note,created_at,resolved_at,record_id,version,space_id)
SELECT task_key,target_project_record_id,note,created_at,resolved_at,record_id,version,space_id
FROM port_ref;
--> statement-breakpoint
CREATE TABLE port_ref_source_without_project_parent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL,
  target_project_record_id TEXT NOT NULL,
  source_project_record_id TEXT NOT NULL,
  commits TEXT NOT NULL,
  paths TEXT NOT NULL,
  note TEXT NOT NULL,
  record_id TEXT NOT NULL,
  space_id TEXT,
  FOREIGN KEY(space_id,target_project_record_id,task_key)
    REFERENCES port_ref_without_project_parent(space_id,target_project_record_id,task_key) ON DELETE CASCADE
);
INSERT INTO port_ref_source_without_project_parent
  (id,task_key,target_project_record_id,source_project_record_id,commits,paths,note,record_id,space_id)
SELECT id,task_key,target_project_record_id,source_project_record_id,commits,paths,note,record_id,space_id
FROM port_ref_source;
--> statement-breakpoint
DROP TABLE port_ref_source;
DROP TABLE port_ref;
DROP TABLE port_skip;
DROP TABLE port_baseline;
DROP TABLE port_pair;
DROP TABLE project_lens_profile_revision;
DROP TABLE project_lens_profile;
ALTER TABLE project_lens_profile_without_project_parent RENAME TO project_lens_profile;
ALTER TABLE project_lens_profile_revision_without_project_parent RENAME TO project_lens_profile_revision;
ALTER TABLE port_pair_without_project_parent RENAME TO port_pair;
ALTER TABLE port_baseline_without_project_parent RENAME TO port_baseline;
ALTER TABLE port_skip_without_project_parent RENAME TO port_skip;
ALTER TABLE port_ref_without_project_parent RENAME TO port_ref;
ALTER TABLE port_ref_source_without_project_parent RENAME TO port_ref_source;
--> statement-breakpoint
CREATE UNIQUE INDEX project_lens_profile_record_id_unique ON project_lens_profile(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX project_lens_profile_local_record_id_unique ON project_lens_profile(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX project_lens_profile_local_global ON project_lens_profile(project_record_id,axis) WHERE space_id IS NULL AND lens_id IS NULL;
CREATE UNIQUE INDEX project_lens_profile_local_specific ON project_lens_profile(project_record_id,lens_id,axis) WHERE space_id IS NULL AND lens_id IS NOT NULL;
CREATE UNIQUE INDEX project_lens_profile_hosted_global ON project_lens_profile(space_id,project_record_id,axis) WHERE space_id IS NOT NULL AND lens_id IS NULL;
CREATE UNIQUE INDEX project_lens_profile_hosted_specific ON project_lens_profile(space_id,project_record_id,lens_id,axis) WHERE space_id IS NOT NULL AND lens_id IS NOT NULL;
CREATE UNIQUE INDEX project_lens_profile_revision_record_id_unique ON project_lens_profile_revision(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX project_lens_profile_revision_local_record_id_unique ON project_lens_profile_revision(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_pair_local_key ON port_pair(source_project_record_id,target_project_record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_pair_hosted_key ON port_pair(space_id,source_project_record_id,target_project_record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_pair_local_record ON port_pair(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_pair_hosted_record ON port_pair(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE INDEX port_pair_target ON port_pair(target_project_record_id);
CREATE UNIQUE INDEX port_baseline_local_record ON port_baseline(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_baseline_hosted_record ON port_baseline(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_skip_local_key ON port_skip(pair_id,candidate) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_skip_hosted_key ON port_skip(space_id,pair_id,candidate) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_skip_local_record ON port_skip(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_skip_hosted_record ON port_skip(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE INDEX port_skip_pair ON port_skip(pair_id);
CREATE UNIQUE INDEX port_ref_local_key ON port_ref(target_project_record_id,task_key) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_ref_hosted_key ON port_ref(space_id,target_project_record_id,task_key) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_ref_local_record ON port_ref(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_ref_hosted_record ON port_ref(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_ref_source_local_key ON port_ref_source(target_project_record_id,task_key,source_project_record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_ref_source_hosted_key ON port_ref_source(space_id,target_project_record_id,task_key,source_project_record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_ref_source_local_record ON port_ref_source(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_ref_source_hosted_record ON port_ref_source(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE INDEX port_ref_source_task ON port_ref_source(target_project_record_id,task_key);
PRAGMA foreign_keys=ON;
