CREATE TABLE lens_space_cache (
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  excludes TEXT NOT NULL,
  slots TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  requires_execution INTEGER NOT NULL DEFAULT 0 CHECK(requires_execution IN (0,1)),
  record_id TEXT NOT NULL,
  space_id TEXT
);
INSERT INTO lens_space_cache SELECT *,NULL FROM lens;
--> statement-breakpoint
CREATE TABLE lens_revision_space_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lens_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  prior_body TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  space_id TEXT
);
INSERT INTO lens_revision_space_cache SELECT *,NULL FROM lens_revision;
--> statement-breakpoint
CREATE TABLE lens_profile_space_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lens_id TEXT NOT NULL,
  axis TEXT NOT NULL CHECK(axis IN ('framework','architecture')),
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  record_id TEXT NOT NULL,
  space_id TEXT
);
INSERT INTO lens_profile_space_cache SELECT *,NULL FROM lens_profile;
--> statement-breakpoint
CREATE TABLE lens_profile_revision_space_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES lens_profile_space_cache(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  prior_body TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  space_id TEXT
);
INSERT INTO lens_profile_revision_space_cache SELECT *,NULL FROM lens_profile_revision;
--> statement-breakpoint
CREATE TABLE project_lens_profile_space_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE CASCADE,
  lens_id TEXT,
  axis TEXT NOT NULL CHECK(axis IN ('framework','architecture')),
  profile_name TEXT NOT NULL,
  selected_version INTEGER CHECK(selected_version IS NULL OR selected_version > 0),
  record_id TEXT NOT NULL,
  selection_version INTEGER NOT NULL DEFAULT 1 CHECK(selection_version > 0),
  space_id TEXT
);
INSERT INTO project_lens_profile_space_cache SELECT *,NULL FROM project_lens_profile;
--> statement-breakpoint
CREATE TABLE project_lens_profile_revision_space_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  selection_id INTEGER NOT NULL REFERENCES project_lens_profile_space_cache(id) ON DELETE CASCADE,
  prior_profile_name TEXT,
  prior_selected_version INTEGER CHECK(prior_selected_version IS NULL OR prior_selected_version > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  space_id TEXT
);
INSERT INTO project_lens_profile_revision_space_cache SELECT *,NULL FROM project_lens_profile_revision;
--> statement-breakpoint
DROP TABLE project_lens_profile_revision;
DROP TABLE project_lens_profile;
DROP TABLE lens_profile_revision;
DROP TABLE lens_profile;
DROP TABLE lens_revision;
DROP TABLE lens;
ALTER TABLE lens_space_cache RENAME TO lens;
ALTER TABLE lens_revision_space_cache RENAME TO lens_revision;
ALTER TABLE lens_profile_space_cache RENAME TO lens_profile;
ALTER TABLE lens_profile_revision_space_cache RENAME TO lens_profile_revision;
ALTER TABLE project_lens_profile_space_cache RENAME TO project_lens_profile;
ALTER TABLE project_lens_profile_revision_space_cache RENAME TO project_lens_profile_revision;
--> statement-breakpoint
CREATE UNIQUE INDEX lens_record_id_unique ON lens(record_id);
CREATE UNIQUE INDEX lens_local_key_unique ON lens(id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX lens_hosted_key_unique ON lens(space_id,id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX lens_revision_record_id_unique ON lens_revision(record_id);
CREATE UNIQUE INDEX lens_revision_local_version ON lens_revision(lens_id,version) WHERE space_id IS NULL;
CREATE UNIQUE INDEX lens_revision_hosted_version ON lens_revision(space_id,lens_id,version) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX lens_profile_record_id_unique ON lens_profile(record_id);
CREATE UNIQUE INDEX lens_profile_local_key ON lens_profile(lens_id,axis,name) WHERE space_id IS NULL;
CREATE UNIQUE INDEX lens_profile_hosted_key ON lens_profile(space_id,lens_id,axis,name) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX lens_profile_revision_record_id_unique ON lens_profile_revision(record_id);
CREATE UNIQUE INDEX lens_profile_revision_local_version ON lens_profile_revision(profile_id,version) WHERE space_id IS NULL;
CREATE UNIQUE INDEX lens_profile_revision_hosted_version ON lens_profile_revision(space_id,profile_id,version) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX project_lens_profile_record_id_unique ON project_lens_profile(record_id);
CREATE UNIQUE INDEX project_lens_profile_local_global ON project_lens_profile(project_record_id,axis) WHERE space_id IS NULL AND lens_id IS NULL;
CREATE UNIQUE INDEX project_lens_profile_local_specific ON project_lens_profile(project_record_id,lens_id,axis) WHERE space_id IS NULL AND lens_id IS NOT NULL;
CREATE UNIQUE INDEX project_lens_profile_hosted_global ON project_lens_profile(space_id,project_record_id,axis) WHERE space_id IS NOT NULL AND lens_id IS NULL;
CREATE UNIQUE INDEX project_lens_profile_hosted_specific ON project_lens_profile(space_id,project_record_id,lens_id,axis) WHERE space_id IS NOT NULL AND lens_id IS NOT NULL;
CREATE UNIQUE INDEX project_lens_profile_revision_record_id_unique ON project_lens_profile_revision(record_id);
