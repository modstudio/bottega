PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
-- newRecordId() is the runtime minter; these are migration-only random UUID-v4 values.
UPDATE run
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
UPDATE question
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
CREATE TEMP TABLE run_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='run'),0) seq;
CREATE TEMP TABLE question_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='question'),0) seq;
CREATE TEMP TABLE run_parent_before_record_identity AS
SELECT id,parent_run_id FROM run WHERE parent_run_id IS NOT NULL;
--> statement-breakpoint
CREATE TEMP TABLE blocker_before_record_identity AS SELECT * FROM blocker;
CREATE TEMP TABLE board_claim_before_record_identity AS SELECT * FROM board_claim;
CREATE TEMP TABLE board_message_before_record_identity AS SELECT * FROM board_message;
CREATE TEMP TABLE board_message_tag_before_record_identity AS SELECT * FROM board_message_tag;
CREATE TEMP TABLE board_receipt_before_record_identity AS SELECT * FROM board_receipt;
CREATE TEMP TABLE calibration_before_record_identity AS SELECT * FROM calibration;
CREATE TEMP TABLE canon_eval_before_record_identity AS SELECT * FROM canon_eval;
CREATE TEMP TABLE check_execution_before_record_identity AS SELECT * FROM check_execution;
CREATE TEMP TABLE compared_pair_before_record_identity AS SELECT * FROM compared_pair;
CREATE TEMP TABLE duel_before_record_identity AS SELECT * FROM duel;
CREATE TEMP TABLE gate_execution_before_record_identity AS SELECT * FROM gate_execution;
CREATE TEMP TABLE question_before_record_identity AS SELECT * FROM question;
CREATE TEMP TABLE question_delivery_before_record_identity AS SELECT * FROM question_delivery;
CREATE TEMP TABLE question_mutation_audit_before_record_identity AS SELECT * FROM question_mutation_audit;
CREATE TEMP TABLE review_finding_before_record_identity AS SELECT * FROM review_finding;
CREATE TEMP TABLE review_lens_before_record_identity AS SELECT * FROM review_lens;
CREATE TEMP TABLE resource_claim_before_record_identity AS SELECT * FROM resource_claim;
CREATE TEMP TABLE run_carried_ruling_before_record_identity AS SELECT * FROM run_carried_ruling;
CREATE TEMP TABLE run_checkpoint_before_record_identity AS SELECT * FROM run_checkpoint;
CREATE TEMP TABLE run_message_before_record_identity AS SELECT * FROM run_message;
CREATE TEMP TABLE run_mutation_audit_before_record_identity AS SELECT * FROM run_mutation_audit;
CREATE TEMP TABLE score_before_record_identity AS SELECT * FROM score;
CREATE TEMP TABLE worker_note_request_before_record_identity AS SELECT * FROM worker_note_request;
--> statement-breakpoint
CREATE TABLE run_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL, agent TEXT NOT NULL, job TEXT NOT NULL, repo TEXT, cwd TEXT,
  prompt_sha TEXT NOT NULL, prompt_bytes INTEGER NOT NULL, prompt_head TEXT NOT NULL,
  label TEXT, lens TEXT, latency_ms INTEGER, exit_code INTEGER, output_bytes INTEGER,
  output_path TEXT, prompt_path TEXT, vendor_tokens INTEGER, vendor_cost_usd REAL,
  probe INTEGER NOT NULL DEFAULT 0, failure_kind TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','ok','failed','stale','asking','stopped')),
  error TEXT, pid INTEGER, session_id TEXT, retry_of INTEGER, launch_cwd TEXT,
  launch_seed TEXT, launch_key TEXT, launch_base TEXT,
  no_failover INTEGER NOT NULL DEFAULT 0, automatic_failover INTEGER NOT NULL DEFAULT 0,
  route_reason TEXT, sandbox TEXT CHECK (sandbox IN ('host','srt')),
  branch TEXT, branch_kept TEXT, branch_kept_tip TEXT, worktree TEXT,
  worktree_source TEXT CHECK (worktree_source IN ('recipe','git','clone','readonly_recipe')),
  vendor_session TEXT, base_commit TEXT, carry_happened INTEGER, carry_base_commit TEXT,
  carry_tracked_paths TEXT, carry_untracked_paths TEXT,
  parent_run_id INTEGER REFERENCES run_record_identity(id),
  turn INTEGER NOT NULL DEFAULT 1, files_changed INTEGER, changed_paths TEXT,
  lines_added INTEGER, lines_removed INTEGER, tests_ran INTEGER, tests_passed INTEGER,
  deviations INTEGER, escalations INTEGER, stack TEXT, model TEXT, run_token TEXT,
  evidence_excluded TEXT, outside_worktree_writes TEXT, input_tree TEXT, head_commit TEXT,
  review_ref TEXT, agent_pid INTEGER, mcp INTEGER, mcp_server TEXT, mcp_connected INTEGER,
  mcp_error TEXT, mcp_trust_granted INTEGER, mcp_trust_path TEXT, schema_path TEXT,
  docs_injected INTEGER, doc_revisions TEXT, canon_sha TEXT,
  transport TEXT CHECK (transport IN ('cli','acp')), pre_confinement TEXT, spec_sha TEXT,
  keep_tree INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  last_event_at TEXT, minted_branch TEXT, unreconciled INTEGER NOT NULL DEFAULT 0,
  mcp_probe TEXT, confinement TEXT, review_provenance TEXT, provenance_status TEXT,
  work_preserved INTEGER NOT NULL DEFAULT 0,
  close_out_outcome TEXT CHECK (
    close_out_outcome IS NULL OR
    close_out_outcome IN ('released','forgotten','held','live','absent','failed')
  ),
  close_out_detail TEXT, close_out_attempted_at TEXT, agent_pgid INTEGER,
  agent_start_time TEXT, keep_tree_until TEXT, keep_tree_reason TEXT, recipe_snapshot TEXT,
  record_id TEXT NOT NULL DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ), started_by_user_id TEXT, task_record_id TEXT,
  gate_requests_closed INTEGER NOT NULL DEFAULT 0 CHECK (gate_requests_closed IN (0,1)),
  resource_teardown TEXT CHECK (resource_teardown IN ('pending','done'))
);
--> statement-breakpoint
INSERT INTO run_record_identity SELECT * FROM run ORDER BY id;
--> statement-breakpoint
DELETE FROM check_execution;
DELETE FROM gate_execution;
DELETE FROM review_finding;
DELETE FROM review_lens;
DELETE FROM question_delivery;
DELETE FROM question_mutation_audit;
DELETE FROM board_claim;
DELETE FROM board_message_tag;
DELETE FROM board_receipt;
DELETE FROM board_message;
DELETE FROM canon_eval;
DELETE FROM resource_claim;
DELETE FROM run_mutation_audit;
DELETE FROM run_carried_ruling;
DELETE FROM question;
DELETE FROM blocker;
DELETE FROM calibration;
DELETE FROM compared_pair;
DELETE FROM duel;
DELETE FROM run_checkpoint;
DELETE FROM run_message;
DELETE FROM score;
DELETE FROM worker_note_request;
--> statement-breakpoint
UPDATE run_record_identity SET parent_run_id=NULL;
UPDATE run SET parent_run_id=NULL;
--> statement-breakpoint
DROP TABLE run;
ALTER TABLE run_record_identity RENAME TO run;
--> statement-breakpoint
CREATE TABLE question_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES run(id) ON DELETE CASCADE,
  workflow_cursor_id INTEGER REFERENCES workflow_cursor(id),
  workflow_key TEXT,
  asked_at TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT,
  recommendation TEXT,
  why TEXT,
  answer TEXT,
  answered_at TEXT,
  answered_by TEXT,
  delivery_pending_at TEXT,
  awaiting_operator_at TEXT,
  relayed_by TEXT,
  asked_via TEXT CHECK (asked_via IN ('live', 'reply', 'workflow')),
  answerer_kind TEXT CHECK (answerer_kind IN ('agent', 'operator', 'eval')),
  answer_channel TEXT,
  overturned_at TEXT,
  overturned_by TEXT,
  overturn_reason TEXT,
  replacement TEXT,
  filed_as TEXT,
  filed_ref TEXT,
  filed_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  record_id TEXT NOT NULL DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  revision INTEGER NOT NULL DEFAULT 1,
  workflow_step_ordinal INTEGER,
  workflow_step_slug TEXT,
  filed_record_id TEXT,
  filed_label TEXT,
  answer_basis TEXT,
  CHECK ((run_id IS NOT NULL) <> (workflow_cursor_id IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO question_record_identity SELECT * FROM question_before_record_identity ORDER BY id;
--> statement-breakpoint
DROP TABLE question;
ALTER TABLE question_record_identity RENAME TO question;
--> statement-breakpoint
UPDATE run
SET parent_run_id=(SELECT parent_run_id FROM run_parent_before_record_identity WHERE id=run.id)
WHERE id IN (SELECT id FROM run_parent_before_record_identity);
--> statement-breakpoint
CREATE INDEX run_job_agent ON run(job, agent);
CREATE INDEX run_project_id ON run(project_id);
CREATE INDEX run_parent_turn ON run(parent_run_id, turn);
CREATE UNIQUE INDEX run_record_id_unique ON run(record_id);
CREATE INDEX question_open ON question(answered_at) WHERE answered_at IS NULL;
CREATE INDEX question_run ON question(run_id);
CREATE INDEX question_workflow_cursor ON question(workflow_cursor_id);
CREATE UNIQUE INDEX question_record_id_unique ON question(record_id);
--> statement-breakpoint
INSERT INTO blocker SELECT * FROM blocker_before_record_identity;
INSERT INTO board_claim SELECT * FROM board_claim_before_record_identity;
INSERT INTO board_message SELECT * FROM board_message_before_record_identity;
INSERT INTO board_message_tag SELECT * FROM board_message_tag_before_record_identity;
INSERT INTO board_receipt SELECT * FROM board_receipt_before_record_identity;
INSERT INTO calibration SELECT * FROM calibration_before_record_identity;
INSERT INTO canon_eval SELECT * FROM canon_eval_before_record_identity;
INSERT INTO compared_pair SELECT * FROM compared_pair_before_record_identity;
INSERT INTO duel SELECT * FROM duel_before_record_identity;
INSERT INTO gate_execution SELECT * FROM gate_execution_before_record_identity;
INSERT INTO check_execution SELECT * FROM check_execution_before_record_identity;
INSERT INTO question_delivery SELECT * FROM question_delivery_before_record_identity;
INSERT INTO question_mutation_audit SELECT * FROM question_mutation_audit_before_record_identity;
INSERT INTO review_lens SELECT * FROM review_lens_before_record_identity;
INSERT INTO review_finding SELECT * FROM review_finding_before_record_identity;
INSERT INTO resource_claim SELECT * FROM resource_claim_before_record_identity;
INSERT INTO run_carried_ruling SELECT * FROM run_carried_ruling_before_record_identity;
INSERT INTO run_checkpoint SELECT * FROM run_checkpoint_before_record_identity;
INSERT INTO run_message SELECT * FROM run_message_before_record_identity;
INSERT INTO run_mutation_audit SELECT * FROM run_mutation_audit_before_record_identity;
INSERT INTO score SELECT * FROM score_before_record_identity;
INSERT INTO worker_note_request SELECT * FROM worker_note_request_before_record_identity;
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name IN ('run','question');
INSERT INTO sqlite_sequence(name,seq)
SELECT 'run',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM run),0))
FROM run_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'question',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM question),0))
FROM question_sequence_before_record_identity saved;
--> statement-breakpoint
DROP TABLE blocker_before_record_identity;
DROP TABLE board_claim_before_record_identity;
DROP TABLE board_message_before_record_identity;
DROP TABLE board_message_tag_before_record_identity;
DROP TABLE board_receipt_before_record_identity;
DROP TABLE calibration_before_record_identity;
DROP TABLE canon_eval_before_record_identity;
DROP TABLE check_execution_before_record_identity;
DROP TABLE compared_pair_before_record_identity;
DROP TABLE duel_before_record_identity;
DROP TABLE gate_execution_before_record_identity;
DROP TABLE question_before_record_identity;
DROP TABLE question_delivery_before_record_identity;
DROP TABLE question_mutation_audit_before_record_identity;
DROP TABLE review_finding_before_record_identity;
DROP TABLE review_lens_before_record_identity;
DROP TABLE resource_claim_before_record_identity;
DROP TABLE run_carried_ruling_before_record_identity;
DROP TABLE run_checkpoint_before_record_identity;
DROP TABLE run_message_before_record_identity;
DROP TABLE run_mutation_audit_before_record_identity;
DROP TABLE score_before_record_identity;
DROP TABLE worker_note_request_before_record_identity;
DROP TABLE run_sequence_before_record_identity;
DROP TABLE question_sequence_before_record_identity;
DROP TABLE run_parent_before_record_identity;
