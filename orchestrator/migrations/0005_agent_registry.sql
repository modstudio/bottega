CREATE TABLE agent (
  name            TEXT PRIMARY KEY,
  harness         TEXT NOT NULL,
  backend         TEXT,
  model           TEXT NOT NULL,
  base_url        TEXT,
  transport       TEXT NOT NULL DEFAULT 'cli' CHECK (transport IN ('cli','acp')),
  caps            TEXT NOT NULL CHECK (json_valid(caps)),
  billing         TEXT NOT NULL CHECK (billing IN ('subscription','free','local','metered','unknown')),
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  disabled_reason TEXT,
  probed_at       TEXT,
  probe_result    TEXT CHECK (probe_result IS NULL OR json_valid(probe_result)),
  CHECK ((enabled = 1 AND disabled_reason IS NULL) OR
         (enabled = 0 AND length(trim(disabled_reason)) > 0))
);
--> statement-breakpoint
INSERT INTO agent
  (name,harness,backend,model,base_url,transport,caps,billing,enabled,disabled_reason,probed_at,probe_result)
VALUES
  ('codex','codex','vendor','gpt-5.6-sol',NULL,'cli','{"readsRepo":true,"mcp":true,"discoversMcpFromCwd":false,"schema":true,"writesRepo":true,"resumable":true,"contextTokens":null}','subscription',1,NULL,'2026-09-07T00:00:00.000Z','{"source":"migrated verified capabilities"}'),
  ('grok','grok','vendor','grok-4.6',NULL,'cli','{"readsRepo":true,"mcp":true,"discoversMcpFromCwd":true,"schema":true,"writesRepo":true,"resumable":true,"contextTokens":null}','subscription',1,NULL,'2026-09-07T00:00:00.000Z','{"source":"migrated verified capabilities"}'),
  ('agy','agy','vendor','gemini-3.1-pro-high',NULL,'cli','{"readsRepo":false,"mcp":false,"discoversMcpFromCwd":false,"schema":true,"writesRepo":false,"resumable":false,"contextTokens":null}','free',0,'no readsRepo; only two inline jobs and negligible evidence','2026-09-07T00:00:00.000Z','{"source":"migrated verified capabilities","legacy":true}'),
  ('qwen-local','qwen','vllm','Qwen/Qwen3.6-35B-A3B',NULL,'cli','{"readsRepo":true,"mcp":true,"discoversMcpFromCwd":false,"schema":false,"writesRepo":false,"resumable":true,"contextTokens":131072}','local',0,'retired bespoke driver; replacement is local-acp','2026-09-07T00:00:00.000Z','{"source":"migrated verified capabilities","legacy":true}');
