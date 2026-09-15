CREATE TEMP TABLE run_sequence_before_rebuild AS
SELECT seq FROM sqlite_sequence WHERE name='run';
--> statement-breakpoint
CREATE TEMP TABLE run_parent_before_rebuild AS
SELECT id,parent_run_id FROM run WHERE parent_run_id IS NOT NULL;
--> statement-breakpoint
CREATE TEMP TABLE blocker_before_run_rebuild AS SELECT * FROM blocker;
--> statement-breakpoint
CREATE TEMP TABLE calibration_before_run_rebuild AS SELECT * FROM calibration;
--> statement-breakpoint
CREATE TEMP TABLE canon_eval_before_run_rebuild AS SELECT * FROM canon_eval;
--> statement-breakpoint
CREATE TEMP TABLE compared_pair_before_run_rebuild AS SELECT * FROM compared_pair;
--> statement-breakpoint
CREATE TEMP TABLE duel_before_run_rebuild AS SELECT * FROM duel;
--> statement-breakpoint
CREATE TEMP TABLE question_before_run_rebuild AS SELECT * FROM question;
--> statement-breakpoint
CREATE TEMP TABLE review_lens_before_run_rebuild AS SELECT * FROM review_lens;
--> statement-breakpoint
CREATE TEMP TABLE run_checkpoint_before_run_rebuild AS SELECT * FROM run_checkpoint;
--> statement-breakpoint
CREATE TEMP TABLE run_message_before_run_rebuild AS SELECT * FROM run_message;
--> statement-breakpoint
CREATE TEMP TABLE run_mutation_audit_before_run_rebuild AS SELECT * FROM run_mutation_audit;
--> statement-breakpoint
CREATE TEMP TABLE score_before_run_rebuild AS SELECT * FROM score;
--> statement-breakpoint
CREATE TABLE run_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  agent TEXT NOT NULL,
  job TEXT NOT NULL,
  repo TEXT,
  cwd TEXT,
  prompt_sha TEXT NOT NULL,
  prompt_bytes INTEGER NOT NULL,
  prompt_head TEXT NOT NULL,
  label TEXT,
  lens TEXT,
  latency_ms INTEGER,
  exit_code INTEGER,
  output_bytes INTEGER,
  output_path TEXT,
  prompt_path TEXT,
  vendor_tokens INTEGER,
  vendor_cost_usd REAL,
  probe INTEGER NOT NULL DEFAULT 0,
  failure_kind TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','ok','failed','stale','asking','stopped')),
  error TEXT,
  pid INTEGER,
  session_id TEXT,
  retry_of INTEGER,
  launch_cwd TEXT,
  launch_seed TEXT,
  launch_key TEXT,
  launch_base TEXT,
  no_failover INTEGER NOT NULL DEFAULT 0,
  automatic_failover INTEGER NOT NULL DEFAULT 0,
  route_reason TEXT,
  sandbox TEXT CHECK (sandbox IN ('host','srt')),
  branch TEXT,
  branch_kept TEXT,
  branch_kept_tip TEXT,
  worktree TEXT,
  worktree_source TEXT CHECK (worktree_source IN ('recipe','git','readonly_recipe')),
  vendor_session TEXT,
  base_commit TEXT,
  carry_happened INTEGER,
  carry_base_commit TEXT,
  carry_tracked_paths TEXT,
  carry_untracked_paths TEXT,
  parent_run_id INTEGER REFERENCES run(id),
  turn INTEGER NOT NULL DEFAULT 1,
  files_changed INTEGER,
  changed_paths TEXT,
  lines_added INTEGER,
  lines_removed INTEGER,
  tests_ran INTEGER,
  tests_passed INTEGER,
  deviations INTEGER,
  escalations INTEGER,
  stack TEXT,
  model TEXT,
  run_token TEXT,
  evidence_excluded TEXT,
  outside_worktree_writes TEXT,
  input_tree TEXT,
  head_commit TEXT,
  review_ref TEXT,
  agent_pid INTEGER,
  mcp INTEGER,
  mcp_server TEXT,
  mcp_connected INTEGER,
  mcp_error TEXT,
  mcp_trust_granted INTEGER,
  mcp_trust_path TEXT,
  schema_path TEXT,
  docs_injected INTEGER,
  doc_revisions TEXT,
  canon_sha TEXT,
  transport TEXT CHECK (transport IN ('cli','acp')),
  pre_confinement TEXT,
  spec_sha TEXT,
  keep_tree INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  last_event_at TEXT,
  minted_branch TEXT,
  unreconciled INTEGER NOT NULL DEFAULT 0,
  mcp_probe TEXT,
  confinement TEXT,
  review_provenance TEXT,
  provenance_status TEXT,
  work_preserved INTEGER NOT NULL DEFAULT 0,
  close_out_outcome TEXT CHECK (
    close_out_outcome IS NULL OR
    close_out_outcome IN ('released','forgotten','held','live','absent','failed')
  ),
  close_out_detail TEXT,
  close_out_attempted_at TEXT,
  agent_pgid INTEGER,
  agent_start_time TEXT
);
--> statement-breakpoint
INSERT INTO run_new SELECT * FROM run ORDER BY id;
--> statement-breakpoint
DELETE FROM blocker;
--> statement-breakpoint
DELETE FROM calibration;
--> statement-breakpoint
DELETE FROM canon_eval;
--> statement-breakpoint
DELETE FROM compared_pair;
--> statement-breakpoint
DELETE FROM duel;
--> statement-breakpoint
DELETE FROM question;
--> statement-breakpoint
DELETE FROM review_lens;
--> statement-breakpoint
DELETE FROM run_checkpoint;
--> statement-breakpoint
DELETE FROM run_message;
--> statement-breakpoint
DELETE FROM run_mutation_audit;
--> statement-breakpoint
DELETE FROM score;
--> statement-breakpoint
UPDATE run_new SET parent_run_id=NULL;
--> statement-breakpoint
UPDATE run SET parent_run_id=NULL;
--> statement-breakpoint
DROP TABLE run;
--> statement-breakpoint
ALTER TABLE run_new RENAME TO run;
--> statement-breakpoint
UPDATE run
SET parent_run_id=(SELECT parent_run_id FROM run_parent_before_rebuild WHERE id=run.id)
WHERE id IN (SELECT id FROM run_parent_before_rebuild);
--> statement-breakpoint
CREATE INDEX run_job_agent ON run(job, agent);
--> statement-breakpoint
CREATE INDEX run_project_id ON run(project_id);
--> statement-breakpoint
INSERT INTO blocker SELECT * FROM blocker_before_run_rebuild;
--> statement-breakpoint
INSERT INTO calibration SELECT * FROM calibration_before_run_rebuild;
--> statement-breakpoint
INSERT INTO canon_eval SELECT * FROM canon_eval_before_run_rebuild;
--> statement-breakpoint
INSERT INTO compared_pair SELECT * FROM compared_pair_before_run_rebuild;
--> statement-breakpoint
INSERT INTO duel SELECT * FROM duel_before_run_rebuild;
--> statement-breakpoint
INSERT INTO question SELECT * FROM question_before_run_rebuild;
--> statement-breakpoint
INSERT INTO review_lens SELECT * FROM review_lens_before_run_rebuild;
--> statement-breakpoint
INSERT INTO run_checkpoint SELECT * FROM run_checkpoint_before_run_rebuild;
--> statement-breakpoint
INSERT INTO run_message SELECT * FROM run_message_before_run_rebuild;
--> statement-breakpoint
INSERT INTO run_mutation_audit SELECT * FROM run_mutation_audit_before_run_rebuild;
--> statement-breakpoint
INSERT INTO score SELECT * FROM score_before_run_rebuild;
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name='run';
--> statement-breakpoint
INSERT INTO sqlite_sequence(name,seq)
SELECT 'run',seq FROM run_sequence_before_rebuild;
--> statement-breakpoint
DROP TABLE blocker_before_run_rebuild;
--> statement-breakpoint
DROP TABLE calibration_before_run_rebuild;
--> statement-breakpoint
DROP TABLE canon_eval_before_run_rebuild;
--> statement-breakpoint
DROP TABLE compared_pair_before_run_rebuild;
--> statement-breakpoint
DROP TABLE duel_before_run_rebuild;
--> statement-breakpoint
DROP TABLE question_before_run_rebuild;
--> statement-breakpoint
DROP TABLE review_lens_before_run_rebuild;
--> statement-breakpoint
DROP TABLE run_checkpoint_before_run_rebuild;
--> statement-breakpoint
DROP TABLE run_message_before_run_rebuild;
--> statement-breakpoint
DROP TABLE run_mutation_audit_before_run_rebuild;
--> statement-breakpoint
DROP TABLE score_before_run_rebuild;
--> statement-breakpoint
DROP TABLE run_sequence_before_rebuild;
--> statement-breakpoint
DROP TABLE run_parent_before_rebuild;
