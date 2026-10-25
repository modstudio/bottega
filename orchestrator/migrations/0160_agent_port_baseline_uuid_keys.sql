CREATE TABLE agent_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  harness TEXT NOT NULL,
  backend TEXT,
  model TEXT NOT NULL,
  base_url TEXT,
  transport TEXT NOT NULL DEFAULT 'cli' CHECK (transport IN ('cli','acp')),
  caps TEXT NOT NULL CHECK (json_valid(caps)),
  billing TEXT NOT NULL CHECK (billing IN ('subscription','free','metered','none','unknown')),
  operated_by TEXT NOT NULL CHECK (operated_by IN ('vendor','self')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  disabled_reason TEXT,
  probed_at TEXT,
  probe_result TEXT CHECK (probe_result IS NULL OR json_valid(probe_result)),
  jobs TEXT CHECK (jobs IS NULL OR json_valid(jobs)),
  preferred_jobs TEXT CHECK (preferred_jobs IS NULL OR json_valid(preferred_jobs)),
  max_concurrent INTEGER CHECK (max_concurrent IS NULL OR max_concurrent > 0),
  api_key_secret TEXT,
  route_metered INTEGER NOT NULL DEFAULT 0 CHECK (route_metered IN (0,1)),
  trains_on_inputs INTEGER NOT NULL DEFAULT 0,
  CHECK ((enabled = 1 AND disabled_reason IS NULL) OR
         (enabled = 0 AND length(trim(disabled_reason)) > 0))
);
INSERT INTO agent_uuid_key(
  record_id,name,harness,backend,model,base_url,transport,caps,billing,operated_by,
  enabled,disabled_reason,probed_at,probe_result,jobs,preferred_jobs,max_concurrent,
  api_key_secret,route_metered,trains_on_inputs
)
SELECT
  record_id,name,harness,backend,model,base_url,transport,caps,billing,operated_by,
  enabled,disabled_reason,probed_at,probe_result,jobs,preferred_jobs,max_concurrent,
  api_key_secret,route_metered,trains_on_inputs
FROM agent ORDER BY name;
DROP TABLE agent;
ALTER TABLE agent_uuid_key RENAME TO agent;
--> statement-breakpoint
CREATE TABLE port_baseline_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  pair_record_id TEXT NOT NULL UNIQUE REFERENCES port_pair(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  source_commit TEXT,
  scanned_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  space_id TEXT,
  CHECK((source_commit IS NULL) = (scanned_at IS NULL))
);
INSERT INTO port_baseline_uuid_key(
  record_id,pair_record_id,source_commit,scanned_at,version,space_id
)
SELECT record_id,pair_record_id,source_commit,scanned_at,version,space_id
FROM port_baseline ORDER BY pair_record_id;
DROP TABLE port_baseline;
ALTER TABLE port_baseline_uuid_key RENAME TO port_baseline;
