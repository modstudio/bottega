CREATE TABLE hosted_call_outcome (
  record_id TEXT NOT NULL PRIMARY KEY,
  observed_at TEXT NOT NULL,
  route_class TEXT NOT NULL,
  http_status INTEGER,
  transport_error TEXT CHECK (transport_error IN ('timeout','refused','dns','reset','other')),
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  CHECK ((http_status IS NULL) <> (transport_error IS NULL))
);
--> statement-breakpoint
CREATE INDEX hosted_call_outcome_observed_at_idx ON hosted_call_outcome(observed_at);
