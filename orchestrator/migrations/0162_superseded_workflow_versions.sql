CREATE TABLE workflow_version_current (
  record_id TEXT NOT NULL PRIMARY KEY,
  workflow_record_id TEXT NOT NULL REFERENCES workflow(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  n INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','production','retired')),
  definition TEXT NOT NULL, author TEXT NOT NULL CHECK(length(trim(author))>0),
  reason TEXT NOT NULL CHECK(length(trim(reason))>0), created_at TEXT NOT NULL,
  promoted_at TEXT, retired_at TEXT, space_id TEXT, superseded_at TEXT
);
INSERT INTO workflow_version_current
SELECT record_id,workflow_record_id,n,status,definition,author,reason,created_at,promoted_at,retired_at,space_id,NULL
FROM workflow_version ORDER BY rowid;
DROP TABLE workflow_version;
ALTER TABLE workflow_version_current RENAME TO workflow_version;
CREATE UNIQUE INDEX workflow_version_current_number
  ON workflow_version(workflow_record_id,n) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX workflow_version_production
  ON workflow_version(workflow_record_id) WHERE status='production' AND superseded_at IS NULL;
CREATE INDEX workflow_version_workflow_record_id ON workflow_version(workflow_record_id,n);
--> statement-breakpoint
CREATE TABLE step_catalogue_version_current (
  record_id TEXT NOT NULL PRIMARY KEY,
  catalogue_record_id TEXT NOT NULL REFERENCES step_catalogue(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  n INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','production','retired')),
  definition TEXT NOT NULL, author TEXT NOT NULL CHECK(length(trim(author))>0),
  reason TEXT NOT NULL CHECK(length(trim(reason))>0), created_at TEXT NOT NULL,
  promoted_at TEXT, retired_at TEXT, space_id TEXT, superseded_at TEXT
);
INSERT INTO step_catalogue_version_current
SELECT record_id,catalogue_record_id,n,status,definition,author,reason,created_at,promoted_at,retired_at,space_id,NULL
FROM step_catalogue_version ORDER BY rowid;
DROP TABLE step_catalogue_version;
ALTER TABLE step_catalogue_version_current RENAME TO step_catalogue_version;
CREATE UNIQUE INDEX step_catalogue_version_current_number
  ON step_catalogue_version(catalogue_record_id,n) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX step_catalogue_version_production
  ON step_catalogue_version(catalogue_record_id) WHERE status='production' AND superseded_at IS NULL;
CREATE INDEX step_catalogue_version_catalogue_record_id
  ON step_catalogue_version(catalogue_record_id,n);
