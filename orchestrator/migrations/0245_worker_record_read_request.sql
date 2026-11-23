CREATE TABLE worker_record_read_request (
  record_id TEXT NOT NULL PRIMARY KEY,
  run_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task','task-document','workflow-text')),
  reference TEXT NOT NULL CHECK (length(trim(reference)) > 0),
  project TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested','result','refused')),
  claimed_at TEXT,
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  refusal TEXT,
  requested_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK (
    (status='requested' AND result IS NULL AND refusal IS NULL AND finished_at IS NULL) OR
    (status='result' AND result IS NOT NULL AND refusal IS NULL AND finished_at IS NOT NULL) OR
    (status='refused' AND result IS NULL AND refusal IS NOT NULL AND finished_at IS NOT NULL)
  )
);
CREATE INDEX worker_record_read_request_pending
  ON worker_record_read_request(run_record_id,status,claimed_at,requested_at,record_id);
