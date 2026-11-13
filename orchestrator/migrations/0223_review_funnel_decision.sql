CREATE TABLE review_funnel_decision (
  record_id TEXT PRIMARY KEY NOT NULL,
  project_record_id TEXT REFERENCES project(record_id),
  surface TEXT NOT NULL,
  task_key TEXT,
  branch TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  patch_id TEXT NOT NULL,
  path_set TEXT NOT NULL CHECK(json_valid(path_set)),
  policy_version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('evaluate','enforce')),
  facts_digest TEXT NOT NULL,
  facts TEXT NOT NULL CHECK(json_valid(facts)),
  stack TEXT,
  verdict TEXT NOT NULL CHECK(json_valid(verdict)),
  outcome TEXT NOT NULL CHECK(outcome IN ('advice','admit','refuse')),
  session_id TEXT,
  recorded_at TEXT NOT NULL
);

CREATE INDEX review_funnel_decision_change
  ON review_funnel_decision(project_record_id,task_key,patch_id,path_set,recorded_at);
