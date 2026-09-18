CREATE TABLE agent_next (
  name            TEXT PRIMARY KEY,
  harness         TEXT NOT NULL,
  backend         TEXT,
  model           TEXT NOT NULL,
  base_url        TEXT,
  transport       TEXT NOT NULL DEFAULT 'cli' CHECK (transport IN ('cli','acp')),
  caps            TEXT NOT NULL CHECK (json_valid(caps)),
  billing         TEXT NOT NULL CHECK (billing IN ('subscription','free','metered','none','unknown')),
  operated_by     TEXT NOT NULL CHECK (operated_by IN ('vendor','self')),
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  disabled_reason TEXT,
  probed_at       TEXT,
  probe_result    TEXT CHECK (probe_result IS NULL OR json_valid(probe_result)),
  jobs            TEXT CHECK (jobs IS NULL OR json_valid(jobs)),
  preferred_jobs  TEXT CHECK (preferred_jobs IS NULL OR json_valid(preferred_jobs)),
  max_concurrent  INTEGER CHECK (max_concurrent IS NULL OR max_concurrent > 0),
  CHECK ((enabled = 1 AND disabled_reason IS NULL) OR
         (enabled = 0 AND length(trim(disabled_reason)) > 0))
);
--> statement-breakpoint
INSERT INTO agent_next
  (name,harness,backend,model,base_url,transport,caps,billing,operated_by,enabled,disabled_reason,probed_at,probe_result,jobs,preferred_jobs,max_concurrent)
SELECT
  name,harness,backend,model,base_url,transport,caps,
  CASE billing WHEN 'local' THEN 'none' ELSE billing END,
  CASE billing WHEN 'local' THEN 'self' ELSE 'vendor' END,
  enabled,disabled_reason,probed_at,probe_result,jobs,preferred_jobs,max_concurrent
FROM agent;
--> statement-breakpoint
DROP TABLE agent;
--> statement-breakpoint
ALTER TABLE agent_next RENAME TO agent;
