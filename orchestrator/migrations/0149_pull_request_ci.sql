CREATE TABLE pull_request_ci (
  record_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  project_record_id TEXT NOT NULL REFERENCES project(record_id),
  pr_number INTEGER NOT NULL,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('collection','attempt')),
  complete INTEGER,
  error TEXT,
  workflow_run_id TEXT,
  run_attempt INTEGER,
  workflow_name TEXT,
  event TEXT,
  head_commit TEXT,
  conclusion TEXT,
  failed_jobs TEXT,
  workflow_created_at TEXT,
  workflow_completed_at TEXT,
  recorded_at TEXT NOT NULL,
  CHECK((record_kind='collection' AND complete IS NOT NULL AND workflow_run_id IS NULL AND run_attempt IS NULL)
     OR (record_kind='attempt' AND complete IS NULL AND workflow_run_id IS NOT NULL AND run_attempt IS NOT NULL)),
  UNIQUE(project_record_id, pr_number, record_kind, workflow_run_id, run_attempt)
);
CREATE UNIQUE INDEX pull_request_ci_collection_unique
  ON pull_request_ci(project_record_id,pr_number) WHERE record_kind='collection';
CREATE INDEX pull_request_ci_pr ON pull_request_ci(project_record_id,pr_number);
