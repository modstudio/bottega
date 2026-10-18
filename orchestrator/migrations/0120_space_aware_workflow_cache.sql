PRAGMA foreign_keys=OFF;
CREATE TABLE workflow_space_cache (id INTEGER PRIMARY KEY AUTOINCREMENT,slug TEXT NOT NULL,created_at TEXT NOT NULL,record_id TEXT NOT NULL,space_id TEXT);
INSERT INTO workflow_space_cache (id,slug,created_at,record_id,space_id) SELECT id,slug,created_at,record_id,NULL FROM workflow;
--> statement-breakpoint
CREATE TABLE workflow_version_space_cache (id INTEGER PRIMARY KEY AUTOINCREMENT,workflow_id INTEGER NOT NULL REFERENCES workflow_space_cache(id) ON DELETE CASCADE,n INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','production','retired')),definition TEXT NOT NULL,author TEXT NOT NULL CHECK(length(trim(author))>0),reason TEXT NOT NULL CHECK(length(trim(reason))>0),created_at TEXT NOT NULL,promoted_at TEXT,retired_at TEXT,record_id TEXT NOT NULL,space_id TEXT,UNIQUE(workflow_id,n));
INSERT INTO workflow_version_space_cache (id,workflow_id,n,status,definition,author,reason,created_at,promoted_at,retired_at,record_id,space_id) SELECT id,workflow_id,n,status,definition,author,reason,created_at,promoted_at,retired_at,record_id,NULL FROM workflow_version;
--> statement-breakpoint
CREATE TABLE workflow_event_space_cache (id INTEGER PRIMARY KEY AUTOINCREMENT,workflow_id INTEGER NOT NULL REFERENCES workflow_space_cache(id) ON DELETE CASCADE,version_n INTEGER NOT NULL,event TEXT NOT NULL CHECK(event IN ('set','fork','import','promote','retire')),author TEXT NOT NULL CHECK(length(trim(author))>0),reason TEXT NOT NULL CHECK(length(trim(reason))>0),session_id TEXT,at TEXT NOT NULL,record_id TEXT NOT NULL,space_id TEXT,FOREIGN KEY(workflow_id,version_n) REFERENCES workflow_version_space_cache(workflow_id,n));
INSERT INTO workflow_event_space_cache (id,workflow_id,version_n,event,author,reason,session_id,at,record_id,space_id) SELECT id,workflow_id,version_n,event,author,reason,session_id,at,record_id,NULL FROM workflow_event;
--> statement-breakpoint
CREATE TABLE step_catalogue_space_cache (id INTEGER PRIMARY KEY AUTOINCREMENT,slug TEXT NOT NULL,created_at TEXT NOT NULL,record_id TEXT NOT NULL,space_id TEXT);
INSERT INTO step_catalogue_space_cache (id,slug,created_at,record_id,space_id) SELECT id,slug,created_at,record_id,NULL FROM step_catalogue;
--> statement-breakpoint
CREATE TABLE step_catalogue_version_space_cache (id INTEGER PRIMARY KEY AUTOINCREMENT,catalogue_id INTEGER NOT NULL REFERENCES step_catalogue_space_cache(id) ON DELETE CASCADE,n INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','production','retired')),definition TEXT NOT NULL,author TEXT NOT NULL CHECK(length(trim(author))>0),reason TEXT NOT NULL CHECK(length(trim(reason))>0),created_at TEXT NOT NULL,promoted_at TEXT,retired_at TEXT,record_id TEXT NOT NULL,space_id TEXT,UNIQUE(catalogue_id,n));
INSERT INTO step_catalogue_version_space_cache (id,catalogue_id,n,status,definition,author,reason,created_at,promoted_at,retired_at,record_id,space_id) SELECT id,catalogue_id,n,status,definition,author,reason,created_at,promoted_at,retired_at,record_id,NULL FROM step_catalogue_version;
--> statement-breakpoint
CREATE TABLE step_catalogue_event_space_cache (id INTEGER PRIMARY KEY AUTOINCREMENT,catalogue_id INTEGER NOT NULL REFERENCES step_catalogue_space_cache(id) ON DELETE CASCADE,version_n INTEGER NOT NULL,event TEXT NOT NULL CHECK(event IN ('set','fork','import','promote','retire')),author TEXT NOT NULL CHECK(length(trim(author))>0),reason TEXT NOT NULL CHECK(length(trim(reason))>0),session_id TEXT,at TEXT NOT NULL,record_id TEXT NOT NULL,space_id TEXT,FOREIGN KEY(catalogue_id,version_n) REFERENCES step_catalogue_version_space_cache(catalogue_id,n));
INSERT INTO step_catalogue_event_space_cache (id,catalogue_id,version_n,event,author,reason,session_id,at,record_id,space_id) SELECT id,catalogue_id,version_n,event,author,reason,session_id,at,record_id,NULL FROM step_catalogue_event;
--> statement-breakpoint
DROP TABLE workflow_event; DROP TABLE workflow_version; DROP TABLE workflow;
DROP TABLE step_catalogue_event; DROP TABLE step_catalogue_version; DROP TABLE step_catalogue;
ALTER TABLE workflow_space_cache RENAME TO workflow;
ALTER TABLE workflow_version_space_cache RENAME TO workflow_version;
ALTER TABLE workflow_event_space_cache RENAME TO workflow_event;
ALTER TABLE step_catalogue_space_cache RENAME TO step_catalogue;
ALTER TABLE step_catalogue_version_space_cache RENAME TO step_catalogue_version;
ALTER TABLE step_catalogue_event_space_cache RENAME TO step_catalogue_event;
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_local_slug ON workflow(slug) WHERE space_id IS NULL;
CREATE UNIQUE INDEX workflow_hosted_slug ON workflow(space_id,slug) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX workflow_local_record ON workflow(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX workflow_hosted_record ON workflow(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX workflow_version_local_record ON workflow_version(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX workflow_version_hosted_record ON workflow_version(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX workflow_event_local_record ON workflow_event(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX workflow_event_hosted_record ON workflow_event(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX workflow_one_production ON workflow_version(workflow_id) WHERE status='production';
CREATE INDEX workflow_version_workflow ON workflow_version(workflow_id,n);
CREATE INDEX workflow_event_version ON workflow_event(workflow_id,version_n,id);
CREATE UNIQUE INDEX step_catalogue_local_slug ON step_catalogue(slug) WHERE space_id IS NULL;
CREATE UNIQUE INDEX step_catalogue_hosted_slug ON step_catalogue(space_id,slug) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX step_catalogue_local_record ON step_catalogue(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX step_catalogue_hosted_record ON step_catalogue(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX step_catalogue_version_local_record ON step_catalogue_version(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX step_catalogue_version_hosted_record ON step_catalogue_version(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX step_catalogue_event_local_record ON step_catalogue_event(record_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX step_catalogue_event_hosted_record ON step_catalogue_event(space_id,record_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX step_catalogue_one_production ON step_catalogue_version(catalogue_id) WHERE status='production';
CREATE INDEX step_catalogue_version_catalogue ON step_catalogue_version(catalogue_id,n);
CREATE INDEX step_catalogue_event_version ON step_catalogue_event(catalogue_id,version_n,id);
PRAGMA foreign_keys=ON;
