PRAGMA foreign_keys=OFF;
CREATE TABLE port_pair_space_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE RESTRICT,
  target_project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  space_id TEXT,
  CHECK(source_project_record_id <> target_project_record_id)
);
INSERT INTO port_pair_space_cache (id,source_project_record_id,target_project_record_id,created_at,record_id,space_id)
SELECT id,source_project_record_id,target_project_record_id,created_at,record_id,NULL FROM port_pair;
--> statement-breakpoint
CREATE TABLE port_baseline_space_cache (
  pair_id INTEGER PRIMARY KEY REFERENCES port_pair_space_cache(id) ON DELETE CASCADE,
  source_commit TEXT,
  scanned_at TEXT,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  space_id TEXT,
  CHECK((source_commit IS NULL) = (scanned_at IS NULL))
);
INSERT INTO port_baseline_space_cache (pair_id,source_commit,scanned_at,record_id,version,space_id)
SELECT pair_id,source_commit,scanned_at,record_id,1,NULL FROM port_baseline;
--> statement-breakpoint
CREATE TABLE port_doctrine_space_cache (
  number INTEGER NOT NULL CHECK(number > 0),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  space_id TEXT
);
INSERT INTO port_doctrine_space_cache (number,title,body,created_at,retired_at,record_id,version,space_id)
SELECT number,title,body,created_at,retired_at,record_id,1,NULL FROM port_doctrine;
--> statement-breakpoint
CREATE TABLE port_ref_space_cache (
  task_key TEXT NOT NULL,
  target_project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE RESTRICT,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  space_id TEXT,
  UNIQUE(space_id,target_project_record_id,task_key)
);
INSERT INTO port_ref_space_cache (task_key,target_project_record_id,note,created_at,resolved_at,record_id,version,space_id)
SELECT task_key,target_project_record_id,note,created_at,resolved_at,record_id,1,NULL FROM port_ref;
--> statement-breakpoint
CREATE TABLE port_ref_source_space_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL,
  target_project_record_id TEXT NOT NULL,
  source_project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE RESTRICT,
  commits TEXT NOT NULL,
  paths TEXT NOT NULL,
  note TEXT NOT NULL,
  record_id TEXT NOT NULL,
  space_id TEXT,
  FOREIGN KEY(space_id,target_project_record_id,task_key)
    REFERENCES port_ref_space_cache(space_id,target_project_record_id,task_key) ON DELETE CASCADE
);
INSERT INTO port_ref_source_space_cache (id,task_key,target_project_record_id,source_project_record_id,commits,paths,note,record_id,space_id)
SELECT id,task_key,target_project_record_id,source_project_record_id,commits,paths,note,record_id,NULL FROM port_ref_source;
--> statement-breakpoint
CREATE TABLE port_skip_space_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id INTEGER NOT NULL REFERENCES port_pair_space_cache(id) ON DELETE CASCADE,
  candidate TEXT NOT NULL,
  reason TEXT NOT NULL,
  skipped_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  space_id TEXT
);
INSERT INTO port_skip_space_cache (id,pair_id,candidate,reason,skipped_at,record_id,space_id)
SELECT id,pair_id,candidate,reason,skipped_at,record_id,NULL FROM port_skip;
--> statement-breakpoint
DROP TABLE port_ref_source;
DROP TABLE port_ref;
DROP TABLE port_skip;
DROP TABLE port_baseline;
DROP TABLE port_pair;
DROP TABLE port_doctrine;
ALTER TABLE port_pair_space_cache RENAME TO port_pair;
ALTER TABLE port_baseline_space_cache RENAME TO port_baseline;
ALTER TABLE port_doctrine_space_cache RENAME TO port_doctrine;
ALTER TABLE port_ref_space_cache RENAME TO port_ref;
ALTER TABLE port_ref_source_space_cache RENAME TO port_ref_source;
ALTER TABLE port_skip_space_cache RENAME TO port_skip;
--> statement-breakpoint
CREATE UNIQUE INDEX port_pair_local_key ON port_pair(source_project_record_id,target_project_record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_pair_hosted_key ON port_pair(space_id,source_project_record_id,target_project_record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_pair_local_record ON port_pair(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_pair_hosted_record ON port_pair(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE INDEX port_pair_target ON port_pair(target_project_record_id);
CREATE UNIQUE INDEX port_baseline_local_record ON port_baseline(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_baseline_hosted_record ON port_baseline(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_doctrine_local_key ON port_doctrine(number) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_doctrine_hosted_key ON port_doctrine(space_id,number) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_doctrine_local_record ON port_doctrine(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_doctrine_hosted_record ON port_doctrine(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_ref_local_key ON port_ref(target_project_record_id,task_key) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_ref_hosted_key ON port_ref(space_id,target_project_record_id,task_key) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_ref_local_record ON port_ref(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_ref_hosted_record ON port_ref(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_ref_source_local_key ON port_ref_source(target_project_record_id,task_key,source_project_record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_ref_source_hosted_key ON port_ref_source(space_id,target_project_record_id,task_key,source_project_record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_ref_source_local_record ON port_ref_source(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_ref_source_hosted_record ON port_ref_source(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE INDEX port_ref_source_task ON port_ref_source(target_project_record_id,task_key);
CREATE UNIQUE INDEX port_skip_local_key ON port_skip(pair_id,candidate) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_skip_hosted_key ON port_skip(space_id,pair_id,candidate) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX port_skip_local_record ON port_skip(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX port_skip_hosted_record ON port_skip(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE INDEX port_skip_pair ON port_skip(pair_id);
PRAGMA foreign_keys=ON;
