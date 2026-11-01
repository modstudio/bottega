CREATE TABLE routing_pool_run (
  record_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  job TEXT NOT NULL,
  stack TEXT,
  prompt_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  failure_kind TEXT,
  executor TEXT NOT NULL,
  evidence_excluded TEXT,
  started_at TEXT NOT NULL,
  latency_ms INTEGER,
  vendor_tokens INTEGER,
  model_calls INTEGER,
  peak_call_tokens INTEGER,
  delivery TEXT,
  quality TEXT,
  fidelity TEXT,
  pulled_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE routing_pool_lens (
  record_id TEXT PRIMARY KEY,
  run_record_id TEXT NOT NULL REFERENCES routing_pool_run(record_id) ON DELETE CASCADE,
  lens TEXT NOT NULL,
  UNIQUE (run_record_id, lens)
);
