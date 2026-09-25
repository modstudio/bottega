CREATE TABLE gate_execution (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  requested_at    TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  exit_code       INTEGER,
  timed_out       INTEGER CHECK (timed_out IS NULL OR timed_out IN (0,1)),
  elapsed_ms      INTEGER,
  output_tail     TEXT,
  output_artifact TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX gate_execution_one_active
  ON gate_execution(run_id) WHERE finished_at IS NULL;
--> statement-breakpoint
CREATE INDEX gate_execution_run ON gate_execution(run_id,id);
