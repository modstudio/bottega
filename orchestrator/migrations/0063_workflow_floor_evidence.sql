ALTER TABLE workflow_cursor ADD COLUMN enforcement TEXT NOT NULL DEFAULT 'note-only'
  CHECK (enforcement IN ('note-only','floors'));
--> statement-breakpoint
ALTER TABLE question ADD COLUMN workflow_step_ordinal INTEGER;
--> statement-breakpoint
ALTER TABLE question ADD COLUMN workflow_step_slug TEXT;
--> statement-breakpoint
CREATE TABLE probe (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  head_commit TEXT,
  exit_code INTEGER NOT NULL,
  output_tail TEXT NOT NULL,
  withheld INTEGER NOT NULL DEFAULT 0 CHECK (withheld IN (0,1)),
  session_id TEXT,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE workflow_obligation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cursor_id INTEGER NOT NULL REFERENCES workflow_cursor(id),
  step_ordinal INTEGER NOT NULL,
  step_slug TEXT NOT NULL,
  floor TEXT NOT NULL,
  require_pull_request INTEGER NOT NULL DEFAULT 0 CHECK (require_pull_request IN (0,1)),
  expected_exit_code INTEGER NOT NULL DEFAULT 0,
  expected_status TEXT NOT NULL DEFAULT 'done',
  floor_deferrable INTEGER NOT NULL DEFAULT 1 CHECK (floor_deferrable IN (0,1)),
  reason TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL,
  satisfied_at TEXT,
  satisfied_step_ordinal INTEGER,
  satisfied_step_slug TEXT,
  satisfied_evidence TEXT,
  abandoned_at TEXT,
  abandoned_reason TEXT
);
--> statement-breakpoint
CREATE INDEX workflow_obligation_open ON workflow_obligation(cursor_id, satisfied_at);
--> statement-breakpoint
CREATE TEMP TABLE gate_execution_sequence_before_floor_evidence AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='gate_execution'),0) seq;
--> statement-breakpoint
CREATE TABLE gate_execution_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES run(id) ON DELETE CASCADE,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  timed_out INTEGER CHECK (timed_out IS NULL OR timed_out IN (0,1)),
  elapsed_ms INTEGER,
  output_tail TEXT,
  output_artifact TEXT,
  cancelled_reason TEXT,
  tooling_paths TEXT NOT NULL DEFAULT '[]',
  resolved_command TEXT,
  head_commit TEXT,
  session_id TEXT,
  cwd TEXT
);
--> statement-breakpoint
INSERT INTO gate_execution_new (
  id,run_id,requested_at,started_at,finished_at,exit_code,timed_out,elapsed_ms,
  output_tail,output_artifact,cancelled_reason,tooling_paths,resolved_command
)
SELECT
  id,run_id,requested_at,started_at,finished_at,exit_code,timed_out,elapsed_ms,
  output_tail,output_artifact,cancelled_reason,tooling_paths,resolved_command
FROM gate_execution;
--> statement-breakpoint
DROP TABLE gate_execution;
--> statement-breakpoint
ALTER TABLE gate_execution_new RENAME TO gate_execution;
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name='gate_execution';
--> statement-breakpoint
INSERT INTO sqlite_sequence(name,seq)
SELECT 'gate_execution',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM gate_execution),0))
FROM gate_execution_sequence_before_floor_evidence saved;
--> statement-breakpoint
DROP TABLE gate_execution_sequence_before_floor_evidence;
--> statement-breakpoint
CREATE UNIQUE INDEX gate_execution_one_active
  ON gate_execution(run_id) WHERE finished_at IS NULL;
--> statement-breakpoint
CREATE INDEX gate_execution_run ON gate_execution(run_id,id);
