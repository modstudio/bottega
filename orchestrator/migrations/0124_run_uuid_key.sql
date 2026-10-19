CREATE TABLE run_run_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  started_at TEXT NOT NULL, agent TEXT NOT NULL, job TEXT NOT NULL, repo TEXT, cwd TEXT,
  prompt_sha TEXT NOT NULL, prompt_bytes INTEGER NOT NULL, prompt_head TEXT NOT NULL,
  label TEXT, lens TEXT, latency_ms INTEGER, exit_code INTEGER, output_bytes INTEGER,
  output_path TEXT, prompt_path TEXT, vendor_tokens INTEGER, vendor_cost_usd REAL,
  probe INTEGER NOT NULL DEFAULT 0, failure_kind TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed','stale','asking','stopped')),
  error TEXT, pid INTEGER, session_id TEXT,
  retry_of_record_id TEXT REFERENCES run_run_uuid(record_id),
  launch_cwd TEXT, launch_seed TEXT, launch_key TEXT, launch_base TEXT,
  no_failover INTEGER NOT NULL DEFAULT 0, automatic_failover INTEGER NOT NULL DEFAULT 0,
  route_reason TEXT, sandbox TEXT CHECK (sandbox IN ('host','srt')),
  branch TEXT, branch_kept TEXT, branch_kept_tip TEXT, worktree TEXT,
  worktree_source TEXT CHECK (worktree_source IN ('recipe','git','clone','readonly_recipe')),
  vendor_session TEXT, base_commit TEXT, carry_happened INTEGER, carry_base_commit TEXT,
  carry_tracked_paths TEXT, carry_untracked_paths TEXT,
  parent_run_record_id TEXT REFERENCES run_run_uuid(record_id),
  turn INTEGER NOT NULL DEFAULT 1, files_changed INTEGER, changed_paths TEXT,
  lines_added INTEGER, lines_removed INTEGER, tests_ran INTEGER, tests_passed INTEGER,
  deviations INTEGER, escalations INTEGER, stack TEXT, model TEXT, run_token TEXT,
  evidence_excluded TEXT, outside_worktree_writes TEXT, input_tree TEXT, head_commit TEXT,
  review_ref TEXT, agent_pid INTEGER, mcp INTEGER, mcp_server TEXT, mcp_connected INTEGER,
  mcp_error TEXT, mcp_trust_granted INTEGER, mcp_trust_path TEXT, schema_path TEXT,
  docs_injected INTEGER, doc_revisions TEXT, canon_sha TEXT,
  transport TEXT CHECK (transport IN ('cli','acp')), pre_confinement TEXT, spec_sha TEXT,
  keep_tree INTEGER NOT NULL DEFAULT 0,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  last_event_at TEXT, minted_branch TEXT, unreconciled INTEGER NOT NULL DEFAULT 0,
  mcp_probe TEXT, confinement TEXT, review_provenance TEXT, provenance_status TEXT,
  work_preserved INTEGER NOT NULL DEFAULT 0,
  close_out_outcome TEXT CHECK (close_out_outcome IS NULL OR close_out_outcome IN ('released','forgotten','held','live','absent','failed')),
  close_out_detail TEXT, close_out_attempted_at TEXT, agent_pgid INTEGER,
  agent_start_time TEXT, keep_tree_until TEXT, keep_tree_reason TEXT, recipe_snapshot TEXT,
  started_by_user_id TEXT, task_record_id TEXT,
  gate_requests_closed INTEGER NOT NULL DEFAULT 0 CHECK (gate_requests_closed IN (0,1)),
  resource_teardown TEXT CHECK (resource_teardown IN ('pending','done'))
);
INSERT INTO run_run_uuid
SELECT record_id,id,started_at,agent,job,repo,cwd,prompt_sha,prompt_bytes,prompt_head,label,lens,
       latency_ms,exit_code,output_bytes,output_path,prompt_path,vendor_tokens,vendor_cost_usd,
       probe,failure_kind,status,error,pid,session_id,
       (SELECT parent.record_id FROM run parent WHERE parent.id=child.retry_of),
       launch_cwd,launch_seed,launch_key,launch_base,no_failover,automatic_failover,route_reason,
       sandbox,branch,branch_kept,branch_kept_tip,worktree,worktree_source,vendor_session,base_commit,
       carry_happened,carry_base_commit,carry_tracked_paths,carry_untracked_paths,
       (SELECT parent.record_id FROM run parent WHERE parent.id=child.parent_run_id),
       turn,files_changed,changed_paths,lines_added,lines_removed,tests_ran,tests_passed,deviations,
       escalations,stack,model,run_token,evidence_excluded,outside_worktree_writes,input_tree,
       head_commit,review_ref,agent_pid,mcp,mcp_server,mcp_connected,mcp_error,mcp_trust_granted,
       mcp_trust_path,schema_path,docs_injected,doc_revisions,canon_sha,transport,pre_confinement,
       spec_sha,keep_tree,project_record_id,last_event_at,minted_branch,unreconciled,mcp_probe,
       confinement,review_provenance,provenance_status,work_preserved,close_out_outcome,
       close_out_detail,close_out_attempted_at,agent_pgid,agent_start_time,keep_tree_until,
       keep_tree_reason,recipe_snapshot,started_by_user_id,task_record_id,gate_requests_closed,
       resource_teardown
FROM run child ORDER BY id;
CREATE TABLE run_number_counter (
  record_id TEXT NOT NULL PRIMARY KEY,
  last_number INTEGER NOT NULL CHECK(last_number >= 0)
);
INSERT INTO run_number_counter(record_id,last_number)
SELECT '00000000-0000-4000-8000-000000000124',
       MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='run'),0),COALESCE(MAX(id),0))
FROM run;
--> statement-breakpoint
CREATE TABLE blocker_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  at TEXT NOT NULL, what TEXT NOT NULL, why TEXT, impact TEXT,
  source TEXT NOT NULL CHECK (source IN ('declared','detected')), kind TEXT, record_id TEXT NOT NULL
);
INSERT INTO blocker_run_uuid SELECT id,(SELECT record_id FROM run WHERE id=old.run_id),at,what,why,impact,source,kind,record_id FROM blocker old;
CREATE TABLE calibration_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  delivery TEXT NOT NULL CHECK (delivery IN ('none','partial','full')), quality TEXT CHECK (quality IN ('wrong','mixed','right')),
  fidelity TEXT CHECK (fidelity IS NULL OR fidelity IN ('drifted','partial','faithful')), at TEXT NOT NULL, session_id TEXT,
  record_id TEXT NOT NULL, CHECK ((delivery = 'none') = (quality IS NULL))
);
INSERT INTO calibration_run_uuid SELECT id,(SELECT record_id FROM run WHERE id=old.run_id),delivery,quality,fidelity,at,session_id,record_id FROM calibration old;
CREATE TABLE canon_eval_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL,
  run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id), canon_sha TEXT NOT NULL,
  agent TEXT NOT NULL, model TEXT, pass INTEGER NOT NULL, why TEXT NOT NULL, at TEXT NOT NULL, record_id TEXT NOT NULL
);
INSERT INTO canon_eval_run_uuid SELECT id,slug,(SELECT record_id FROM run WHERE id=old.run_id),canon_sha,agent,model,pass,why,at,record_id FROM canon_eval old;
CREATE TABLE compared_pair_run_uuid (
  run_a_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  run_b_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  compared_at TEXT NOT NULL, record_id TEXT NOT NULL,
  PRIMARY KEY (run_a_record_id,run_b_record_id), CHECK (run_a_record_id < run_b_record_id)
);
INSERT INTO compared_pair_run_uuid
SELECT CASE WHEN run_a.record_id < run_b.record_id THEN run_a.record_id ELSE run_b.record_id END,
       CASE WHEN run_a.record_id < run_b.record_id THEN run_b.record_id ELSE run_a.record_id END,
       old.compared_at,old.record_id
FROM compared_pair old
JOIN run run_a ON run_a.id=old.run_a_id
JOIN run run_b ON run_b.id=old.run_b_id;
CREATE TABLE duel_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL,
  winner_run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  loser_run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  session_id TEXT, at TEXT NOT NULL, record_id TEXT NOT NULL,
  CHECK (winner_run_record_id <> loser_run_record_id), UNIQUE (winner_run_record_id,loser_run_record_id)
);
INSERT INTO duel_run_uuid SELECT id,job,(SELECT record_id FROM run WHERE id=old.winner_run_id),(SELECT record_id FROM run WHERE id=old.loser_run_id),session_id,at,record_id FROM duel old;
CREATE TABLE score_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  delivery TEXT NOT NULL CHECK (delivery IN ('none','partial','full')), quality TEXT CHECK (quality IN ('wrong','mixed','right')),
  fidelity TEXT CHECK (fidelity IS NULL OR fidelity IN ('drifted','partial','faithful')), note TEXT, scored_at TEXT NOT NULL,
  scored_by TEXT NOT NULL DEFAULT 'claude', record_id TEXT NOT NULL, CHECK ((delivery = 'none') = (quality IS NULL))
);
INSERT INTO score_run_uuid SELECT id,(SELECT record_id FROM run WHERE id=old.run_id),delivery,quality,fidelity,note,scored_at,scored_by,record_id FROM score old;
CREATE TABLE run_checkpoint_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  checkpoint_no INTEGER NOT NULL, commit_sha TEXT NOT NULL, task_pointer TEXT, final INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, record_id TEXT NOT NULL, UNIQUE(run_record_id,checkpoint_no)
);
INSERT INTO run_checkpoint_run_uuid SELECT id,(SELECT record_id FROM run WHERE id=old.run_id),checkpoint_no,commit_sha,task_pointer,final,created_at,record_id FROM run_checkpoint old;
CREATE TABLE run_carried_ruling_run_uuid_snapshot AS
SELECT (SELECT record_id FROM run WHERE id=old.run_id) AS run_record_id,question_id,record_id
FROM run_carried_ruling old;
--> statement-breakpoint
CREATE TABLE gate_execution_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_record_id TEXT REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  requested_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, exit_code INTEGER,
  timed_out INTEGER CHECK (timed_out IS NULL OR timed_out IN (0,1)), elapsed_ms INTEGER,
  output_tail TEXT, output_artifact TEXT, cancelled_reason TEXT, tooling_paths TEXT NOT NULL DEFAULT '[]',
  resolved_command TEXT, head_commit TEXT, session_id TEXT, cwd TEXT, record_id TEXT NOT NULL
);
INSERT INTO gate_execution_run_uuid SELECT id,(SELECT record_id FROM run WHERE id=old.run_id),requested_at,started_at,finished_at,exit_code,timed_out,elapsed_ms,output_tail,output_artifact,cancelled_reason,tooling_paths,resolved_command,head_commit,session_id,cwd,record_id FROM gate_execution old;
CREATE TABLE check_execution_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_execution_id INTEGER NOT NULL REFERENCES gate_execution_run_uuid(id) ON DELETE CASCADE,
  check_name TEXT NOT NULL, category TEXT,
  wall_ms REAL NOT NULL CHECK (wall_ms >= 0), cpu_ms REAL CHECK (cpu_ms IS NULL OR cpu_ms >= 0),
  exit_code INTEGER NOT NULL, remaining_count INTEGER CHECK (remaining_count IS NULL OR remaining_count >= 0),
  record_id TEXT NOT NULL
);
INSERT INTO check_execution_run_uuid SELECT id,gate_execution_id,check_name,category,wall_ms,cpu_ms,exit_code,remaining_count,record_id FROM check_execution;
CREATE TABLE question_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_record_id TEXT REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  workflow_cursor_id INTEGER REFERENCES workflow_cursor(id), workflow_key TEXT, asked_at TEXT NOT NULL,
  question TEXT NOT NULL, options TEXT, recommendation TEXT, why TEXT, answer TEXT, answered_at TEXT,
  answered_by TEXT, delivery_pending_at TEXT, awaiting_operator_at TEXT, relayed_by TEXT,
  asked_via TEXT CHECK (asked_via IN ('live','reply','workflow')),
  answerer_kind TEXT CHECK (answerer_kind IN ('agent','operator','eval')), answer_channel TEXT,
  overturned_at TEXT, overturned_by TEXT, overturn_reason TEXT, replacement TEXT, filed_as TEXT,
  filed_ref TEXT, filed_at TEXT, closed_at TEXT, close_reason TEXT, record_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, workflow_step_ordinal INTEGER, workflow_step_slug TEXT,
  filed_record_id TEXT, filed_label TEXT, answer_basis TEXT,
  CHECK ((run_record_id IS NOT NULL) <> (workflow_cursor_id IS NOT NULL))
);
INSERT INTO question_run_uuid SELECT id,(SELECT record_id FROM run WHERE id=old.run_id),workflow_cursor_id,workflow_key,asked_at,question,options,recommendation,why,answer,answered_at,answered_by,delivery_pending_at,awaiting_operator_at,relayed_by,asked_via,answerer_kind,answer_channel,overturned_at,overturned_by,overturn_reason,replacement,filed_as,filed_ref,filed_at,closed_at,close_reason,record_id,revision,workflow_step_ordinal,workflow_step_slug,filed_record_id,filed_label,answer_basis FROM question old;
CREATE TABLE question_delivery_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL REFERENCES question_run_uuid(id) ON DELETE CASCADE,
  run_record_id TEXT REFERENCES run_run_uuid(record_id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live','resume','retry','record-only')),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered','failed','retired')), at TEXT NOT NULL, error TEXT, record_id TEXT NOT NULL
);
INSERT INTO question_delivery_run_uuid SELECT id,question_id,(SELECT record_id FROM run WHERE id=old.run_id),mode,outcome,at,error,record_id FROM question_delivery old;
CREATE TABLE question_mutation_audit_run_uuid (
  question_id INTEGER NOT NULL REFERENCES question_run_uuid(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('rule','overturn','file','close')),
  actor_session TEXT, at TEXT NOT NULL, reason TEXT, record_id TEXT NOT NULL
);
INSERT INTO question_mutation_audit_run_uuid SELECT question_id,action,actor_session,at,reason,record_id FROM question_mutation_audit;
CREATE TABLE review_lens_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, review_id INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  run_record_id TEXT NOT NULL UNIQUE REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  lens TEXT NOT NULL, agent TEXT NOT NULL, model TEXT, tree_inspected TEXT, reviewed_tree TEXT,
  standards_read TEXT NOT NULL, files_covered TEXT NOT NULL, commands_run TEXT NOT NULL,
  could_not_verify TEXT NOT NULL, reproduced TEXT CHECK (reproduced IS NULL OR reproduced IN ('none','some','all')),
  coverage TEXT CHECK (coverage IS NULL OR coverage IN ('empty','partial','adequate')),
  limits TEXT CHECK (limits IS NULL OR limits IN ('named','absent')),
  overlap TEXT CHECK (overlap IS NULL OR overlap IN ('unique','shared','none','alone')),
  mcp_tools TEXT NOT NULL DEFAULT '[]', docs_read TEXT NOT NULL DEFAULT '[]',
  substitutes TEXT NOT NULL DEFAULT '[]', record_id TEXT NOT NULL
);
INSERT INTO review_lens_run_uuid SELECT id,review_id,(SELECT record_id FROM run WHERE id=old.run_id),lens,agent,model,tree_inspected,reviewed_tree,standards_read,files_covered,commands_run,could_not_verify,reproduced,coverage,limits,overlap,mcp_tools,docs_read,substitutes,record_id FROM review_lens old;
CREATE TABLE review_finding_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  review_lens_id INTEGER NOT NULL REFERENCES review_lens_run_uuid(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, severity TEXT NOT NULL, location TEXT NOT NULL, evidence TEXT NOT NULL,
  proposed_correction TEXT NOT NULL,
  disposition TEXT CHECK (disposition IS NULL OR disposition IN ('accepted','modified','rejected','skipped')),
  rejection_category TEXT,
  triaged_severity TEXT CHECK (triaged_severity IS NULL OR triaged_severity IN ('critical','high','medium','low')),
  triaged_at TEXT, record_id TEXT NOT NULL,
  UNIQUE(review_id,ordinal), CHECK (disposition = 'rejected' OR rejection_category IS NULL)
);
INSERT INTO review_finding_run_uuid SELECT id,review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction,disposition,rejection_category,triaged_severity,triaged_at,record_id FROM review_finding;
CREATE TABLE resource_claim_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id),
  run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id),
  project_record_id TEXT REFERENCES project(record_id),
  kind TEXT NOT NULL CHECK (kind IN ('worktree','branch','retained_ref','sandbox_dir','trust_entry','port','database','index','string')),
  allocation_key TEXT NOT NULL, identity TEXT, label TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed','released','retained','forgotten','absent')),
  claimed_at TEXT NOT NULL, settled_at TEXT, settled_detail TEXT, record_id TEXT NOT NULL
);
INSERT INTO resource_claim_run_uuid SELECT id,(SELECT record_id FROM run WHERE id=old.root_run_id),(SELECT record_id FROM run WHERE id=old.run_id),project_record_id,kind,allocation_key,identity,label,state,claimed_at,settled_at,settled_detail,record_id FROM resource_claim old;
CREATE TABLE run_message_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT NOT NULL CHECK (direction IN ('to_worker','from_worker')),
  root_run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  sender_session TEXT, body TEXT NOT NULL CHECK (length(trim(body)) > 0), created_at TEXT NOT NULL,
  read_at TEXT, delivery TEXT NOT NULL CHECK (delivery IN ('architect_cli','worker_tool')), read_by TEXT, record_id TEXT NOT NULL
);
INSERT INTO run_message_run_uuid SELECT id,direction,(SELECT record_id FROM run WHERE id=old.root_run_id),(SELECT record_id FROM run WHERE id=old.run_id),sender_session,body,created_at,read_at,delivery,read_by,record_id FROM run_message old;
CREATE TABLE run_mutation_audit_run_uuid (
  run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id),
  root_run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id),
  action TEXT NOT NULL CHECK (action IN ('adopt','answer','overturn','file','tell','relay','stop','abandon','discard','sweep','reap','void','unvoid','score','rescore','retry','continue','reclassify','canon-eval')),
  actor_session TEXT CHECK (actor_session IS NULL OR length(actor_session) > 0), at TEXT NOT NULL,
  reason TEXT, turn_run_record_id TEXT REFERENCES run_run_uuid(record_id), record_id TEXT NOT NULL
);
INSERT INTO run_mutation_audit_run_uuid SELECT (SELECT record_id FROM run WHERE id=old.run_id),(SELECT record_id FROM run WHERE id=old.root_id),action,actor_session,at,reason,(SELECT record_id FROM run WHERE id=old.turn_id),record_id FROM run_mutation_audit old;
CREATE TABLE worker_note_request_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000 AND instr(text,char(10))=0 AND instr(text,char(13))=0),
  file TEXT CHECK (file IS NULL OR length(file) BETWEEN 1 AND 1000), same_as TEXT CHECK (same_as IS NULL OR length(same_as) BETWEEN 1 AND 1000),
  requested_at TEXT NOT NULL, claimed_at TEXT, finished_at TEXT, status TEXT NOT NULL CHECK (status IN ('requested','filed','refused')),
  note_record_id TEXT, note_label TEXT, candidate_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_ids)),
  candidate_labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_labels)),
  refusal_class TEXT CHECK (refusal_class IN ('anchor-refused','filing-refused','supervisor-closed')),
  detail TEXT, project TEXT, project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT, record_id TEXT NOT NULL,
  CHECK ((status='requested' AND finished_at IS NULL AND note_record_id IS NULL AND note_label IS NULL AND refusal_class IS NULL) OR
         (status='filed' AND finished_at IS NOT NULL AND note_label IS NOT NULL AND refusal_class IS NULL) OR
         (status='refused' AND finished_at IS NOT NULL AND note_record_id IS NULL AND note_label IS NULL AND refusal_class IS NOT NULL))
);
INSERT INTO worker_note_request_run_uuid SELECT id,(SELECT record_id FROM run WHERE id=old.run_id),text,file,same_as,requested_at,claimed_at,finished_at,status,note_record_id,note_label,candidate_ids,candidate_labels,refusal_class,detail,project,project_record_id,record_id FROM worker_note_request old;
--> statement-breakpoint
CREATE TABLE board_claim_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('task','path','resource')), subject_value TEXT NOT NULL,
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('operator','architect')), holder_session TEXT, note TEXT,
  run_record_id TEXT REFERENCES run_run_uuid(record_id), duration_ms INTEGER NOT NULL, taken_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL, lapses_at TEXT NOT NULL, closed_at TEXT,
  close_reason TEXT CHECK (close_reason IN ('released','lapsed','run-ended','task-closed','taken-over')),
  superseded_by_claim_id INTEGER REFERENCES board_claim_run_uuid(id), record_id TEXT NOT NULL,
  CHECK ((holder_kind='operator' AND holder_session IS NULL) OR (holder_kind='architect' AND holder_session IS NOT NULL)),
  CHECK ((closed_at IS NULL AND close_reason IS NULL) OR (closed_at IS NOT NULL AND close_reason IS NOT NULL))
);
INSERT INTO board_claim_run_uuid SELECT id,project,project_record_id,subject_kind,subject_value,holder_kind,holder_session,note,(SELECT record_id FROM run WHERE id=old.run_id),duration_ms,taken_at,renewed_at,lapses_at,closed_at,close_reason,superseded_by_claim_id,record_id FROM board_claim old;
CREATE TABLE board_message_run_uuid_snapshot AS
SELECT id,kind,author_kind,author_session,author_run_id,
       CAST(NULL AS TEXT) AS author_run_record_id,
       audience,title,body,ack_required,ack_deadline,expires_at,created_at,withdrawn_at,
       author_harness,author_project,thread_root_id,accepted_reply_id,accepted_by,accepted_at,
       note_record_id,note_label,note_pending_error,note_filing_started_at,claim_id,purpose,
       record_id,author_project_record_id
FROM board_message;
UPDATE board_message_run_uuid_snapshot
SET author_run_record_id=(SELECT record_id FROM run WHERE id=author_run_id);
CREATE TABLE board_message_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('notice','suggestion','question','reply')),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('operator','architect','worker')), author_session TEXT,
  author_run_record_id TEXT REFERENCES run_run_uuid(record_id), audience TEXT, title TEXT, body TEXT NOT NULL,
  ack_required INTEGER NOT NULL CHECK (ack_required IN (0,1)), ack_deadline TEXT, expires_at TEXT,
  created_at TEXT NOT NULL, withdrawn_at TEXT, author_harness TEXT, author_project TEXT,
  thread_root_id INTEGER REFERENCES board_message_run_uuid(id) ON DELETE CASCADE,
  accepted_reply_id INTEGER REFERENCES board_message_run_uuid(id), accepted_by TEXT, accepted_at TEXT,
  note_record_id TEXT, note_label TEXT, note_pending_error TEXT, note_filing_started_at TEXT,
  claim_id INTEGER REFERENCES board_claim_run_uuid(id), purpose TEXT CHECK (purpose IS NULL OR purpose IN ('information','request','standing')),
  record_id TEXT NOT NULL, author_project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  CHECK ((author_kind='operator' AND author_session IS NULL AND author_run_record_id IS NULL) OR
         (author_kind='architect' AND author_session IS NOT NULL AND author_session<>'operator') OR
         (author_kind='worker' AND author_session IS NULL AND author_run_record_id IS NOT NULL)),
  CHECK ((kind='reply' AND thread_root_id IS NOT NULL AND audience IS NULL AND title IS NULL AND ack_required=0 AND ack_deadline IS NULL AND expires_at IS NULL) OR
         (kind<>'reply' AND thread_root_id IS NULL AND audience IS NOT NULL AND title IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK ((accepted_reply_id IS NULL AND accepted_by IS NULL AND accepted_at IS NULL) OR
         (kind='question' AND accepted_reply_id IS NOT NULL AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK (kind='question' OR (note_record_id IS NULL AND note_label IS NULL AND note_pending_error IS NULL AND note_filing_started_at IS NULL))
);
CREATE TABLE board_message_tag_run_uuid (
  message_id INTEGER NOT NULL REFERENCES board_message_run_uuid(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task','path','topic')), value TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('sender','inferred')), record_id TEXT NOT NULL,
  PRIMARY KEY (message_id,kind,value,origin)
);
INSERT INTO board_message_tag_run_uuid SELECT message_id,kind,value,origin,record_id FROM board_message_tag;
CREATE TABLE board_receipt_run_uuid (
  message_id INTEGER NOT NULL REFERENCES board_message_run_uuid(id) ON DELETE CASCADE,
  reader_session TEXT NOT NULL, audience_at_posting INTEGER NOT NULL CHECK (audience_at_posting IN (0,1)),
  delivered_at TEXT, acknowledged_at TEXT, record_id TEXT NOT NULL,
  PRIMARY KEY (message_id,reader_session)
);
INSERT INTO board_receipt_run_uuid SELECT message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,record_id FROM board_receipt;
CREATE TABLE contention_run_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, session_id TEXT,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('trunk','main_checkout','store','cpu','vendor','review','register','lock')),
  resource_key TEXT NOT NULL, event_kind TEXT NOT NULL CHECK (event_kind IN ('wait','refusal','invalidation','retry','timeout')),
  duration_ms INTEGER, cause TEXT, run_record_id TEXT REFERENCES run_run_uuid(record_id), landing_id INTEGER, record_id TEXT NOT NULL
);
INSERT INTO contention_run_uuid SELECT id,at,session_id,resource_kind,resource_key,event_kind,duration_ms,cause,(SELECT record_id FROM run WHERE id=old.run_id),landing_id,record_id FROM contention old;
--> statement-breakpoint
DROP TABLE blocker;
DROP TABLE calibration;
DROP TABLE canon_eval;
DROP TABLE compared_pair;
DROP TABLE duel;
DROP TABLE score;
DROP TABLE run_checkpoint;
DROP TABLE run_carried_ruling;
DROP TABLE check_execution;
DROP TABLE gate_execution;
DROP TABLE question_mutation_audit;
DROP TABLE question_delivery;
DROP TABLE question;
DROP TABLE review_finding;
DROP TABLE review_lens;
DROP TABLE resource_claim;
DROP TABLE run_message;
DROP TABLE run_mutation_audit;
DROP TABLE worker_note_request;
DROP TABLE board_message_tag;
DROP TABLE board_receipt;
DROP TABLE board_message;
DROP TABLE board_claim;
DROP TABLE contention;
DROP TABLE run;
CREATE TABLE run_carried_ruling_run_uuid (
  run_record_id TEXT NOT NULL REFERENCES run_run_uuid(record_id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES question_run_uuid(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  PRIMARY KEY (run_record_id,question_id)
);
INSERT INTO run_carried_ruling_run_uuid SELECT * FROM run_carried_ruling_run_uuid_snapshot;
DROP TABLE run_carried_ruling_run_uuid_snapshot;
INSERT INTO board_message_run_uuid
SELECT id,kind,author_kind,author_session,author_run_record_id,audience,title,body,
       ack_required,ack_deadline,expires_at,created_at,withdrawn_at,author_harness,
       author_project,thread_root_id,accepted_reply_id,accepted_by,accepted_at,note_record_id,
       note_label,note_pending_error,note_filing_started_at,claim_id,purpose,record_id,
       author_project_record_id
FROM board_message_run_uuid_snapshot;
DROP TABLE board_message_run_uuid_snapshot;
ALTER TABLE run_run_uuid RENAME TO run;
ALTER TABLE blocker_run_uuid RENAME TO blocker;
ALTER TABLE calibration_run_uuid RENAME TO calibration;
ALTER TABLE canon_eval_run_uuid RENAME TO canon_eval;
ALTER TABLE compared_pair_run_uuid RENAME TO compared_pair;
ALTER TABLE duel_run_uuid RENAME TO duel;
ALTER TABLE score_run_uuid RENAME TO score;
ALTER TABLE run_checkpoint_run_uuid RENAME TO run_checkpoint;
ALTER TABLE run_carried_ruling_run_uuid RENAME TO run_carried_ruling;
ALTER TABLE gate_execution_run_uuid RENAME TO gate_execution;
ALTER TABLE check_execution_run_uuid RENAME TO check_execution;
ALTER TABLE question_run_uuid RENAME TO question;
ALTER TABLE question_delivery_run_uuid RENAME TO question_delivery;
ALTER TABLE question_mutation_audit_run_uuid RENAME TO question_mutation_audit;
ALTER TABLE review_lens_run_uuid RENAME TO review_lens;
ALTER TABLE review_finding_run_uuid RENAME TO review_finding;
ALTER TABLE resource_claim_run_uuid RENAME TO resource_claim;
ALTER TABLE run_message_run_uuid RENAME TO run_message;
ALTER TABLE run_mutation_audit_run_uuid RENAME TO run_mutation_audit;
ALTER TABLE worker_note_request_run_uuid RENAME TO worker_note_request;
ALTER TABLE board_claim_run_uuid RENAME TO board_claim;
ALTER TABLE board_message_run_uuid RENAME TO board_message;
ALTER TABLE board_message_tag_run_uuid RENAME TO board_message_tag;
ALTER TABLE board_receipt_run_uuid RENAME TO board_receipt;
ALTER TABLE contention_run_uuid RENAME TO contention;
--> statement-breakpoint
CREATE INDEX run_job_agent ON run(job,agent);
CREATE INDEX run_parent_turn ON run(parent_run_record_id,turn);
CREATE INDEX run_project_id ON run(project_record_id);
CREATE INDEX run_automatic_failover_retry ON run(retry_of_record_id,number) WHERE automatic_failover=1;
CREATE INDEX blocker_kind ON blocker(kind,at);
CREATE UNIQUE INDEX blocker_record_id_unique ON blocker(record_id);
CREATE INDEX blocker_run ON blocker(run_record_id);
CREATE UNIQUE INDEX calibration_record_id_unique ON calibration(record_id);
CREATE UNIQUE INDEX canon_eval_record_id_unique ON canon_eval(record_id);
CREATE UNIQUE INDEX compared_pair_record_id_unique ON compared_pair(record_id);
CREATE INDEX duel_job ON duel(job);
CREATE UNIQUE INDEX duel_record_id_unique ON duel(record_id);
CREATE UNIQUE INDEX score_one_per_run ON score(run_record_id);
CREATE UNIQUE INDEX score_record_id_unique ON score(record_id);
CREATE INDEX score_run ON score(run_record_id);
CREATE UNIQUE INDEX run_checkpoint_record_id_unique ON run_checkpoint(record_id);
CREATE UNIQUE INDEX run_carried_ruling_record_id_unique ON run_carried_ruling(record_id);
CREATE UNIQUE INDEX gate_execution_one_active ON gate_execution(run_record_id) WHERE finished_at IS NULL;
CREATE UNIQUE INDEX gate_execution_record_id_unique ON gate_execution(record_id);
CREATE INDEX gate_execution_run ON gate_execution(run_record_id,id);
CREATE INDEX check_execution_category_newest ON check_execution(category,gate_execution_id DESC);
CREATE UNIQUE INDEX check_execution_record_id_unique ON check_execution(record_id);
CREATE INDEX question_open ON question(answered_at) WHERE answered_at IS NULL;
CREATE UNIQUE INDEX question_record_id_unique ON question(record_id);
CREATE INDEX question_run ON question(run_record_id);
CREATE INDEX question_workflow_cursor ON question(workflow_cursor_id);
CREATE INDEX question_delivery_question ON question_delivery(question_id,id);
CREATE UNIQUE INDEX question_delivery_record_id_unique ON question_delivery(record_id);
CREATE INDEX question_mutation_audit_question ON question_mutation_audit(question_id,at);
CREATE UNIQUE INDEX question_mutation_audit_record_id_unique ON question_mutation_audit(record_id);
CREATE INDEX review_calibration ON review_lens(lens,agent,model,review_id);
CREATE UNIQUE INDEX review_lens_record_id_unique ON review_lens(record_id);
CREATE UNIQUE INDEX review_finding_record_id_unique ON review_finding(record_id);
CREATE UNIQUE INDEX resource_claim_one_live_allocation ON resource_claim(kind,allocation_key) WHERE state='claimed';
CREATE UNIQUE INDEX resource_claim_record_id_unique ON resource_claim(record_id);
CREATE UNIQUE INDEX run_message_record_id_unique ON run_message(record_id);
CREATE INDEX run_message_root ON run_message(root_run_record_id,id);
CREATE INDEX run_message_unread ON run_message(root_run_record_id,direction,read_at) WHERE read_at IS NULL;
CREATE UNIQUE INDEX run_mutation_audit_record_id_unique ON run_mutation_audit(record_id);
CREATE INDEX run_mutation_audit_root ON run_mutation_audit(root_run_record_id);
CREATE INDEX run_mutation_audit_turn ON run_mutation_audit(turn_run_record_id);
CREATE INDEX worker_note_request_pending ON worker_note_request(run_record_id,status,claimed_at,id);
CREATE INDEX worker_note_request_project_record_id ON worker_note_request(project_record_id);
CREATE UNIQUE INDEX worker_note_request_record_id_unique ON worker_note_request(record_id);
CREATE INDEX board_claim_project_subject ON board_claim(project_record_id,subject_kind,subject_value,closed_at);
CREATE UNIQUE INDEX board_claim_record_id_unique ON board_claim(record_id);
CREATE INDEX board_claim_run ON board_claim(run_record_id,closed_at);
CREATE INDEX board_claim_superseded ON board_claim(superseded_by_claim_id);
CREATE INDEX board_message_author_project_record_id ON board_message(author_project_record_id);
CREATE INDEX board_message_author_rate ON board_message(author_kind,author_session,author_run_record_id,created_at);
CREATE INDEX board_message_delivery ON board_message(expires_at,withdrawn_at,created_at);
CREATE UNIQUE INDEX board_message_record_id_unique ON board_message(record_id);
CREATE INDEX board_message_thread ON board_message(thread_root_id,created_at,id);
CREATE INDEX board_message_tag_message ON board_message_tag(message_id);
CREATE UNIQUE INDEX board_message_tag_record_id_unique ON board_message_tag(record_id);
CREATE UNIQUE INDEX board_receipt_record_id_unique ON board_receipt(record_id);
CREATE INDEX contention_kind_at ON contention(resource_kind,at);
CREATE INDEX contention_landing ON contention(landing_id);
CREATE UNIQUE INDEX contention_record_id_unique ON contention(record_id);
CREATE INDEX contention_session_at ON contention(session_id,at);
-- BACKFILL
UPDATE run SET project_record_id=(SELECT record_id FROM project WHERE name=run.repo)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=run.repo)=1;
UPDATE run SET project_record_id=(SELECT record_id FROM project WHERE name='bottega')
WHERE repo IN ('devbox','devbox-ops') AND project_record_id IS NULL;
UPDATE canon_pack SET project_record_id=(SELECT record_id FROM project WHERE name=canon_pack.project)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=canon_pack.project)=1;
UPDATE landing SET project_record_id=(SELECT record_id FROM project WHERE name=landing.project)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=landing.project)=1;
UPDATE landing_override SET project_record_id=(SELECT record_id FROM project WHERE name=landing_override.project)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=landing_override.project)=1;
UPDATE landing_review_carry SET project_record_id=(SELECT record_id FROM project WHERE name=landing_review_carry.project)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=landing_review_carry.project)=1;
UPDATE landing_triage_snapshot SET project_record_id=(SELECT record_id FROM project WHERE name=landing_triage_snapshot.project)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=landing_triage_snapshot.project)=1;
UPDATE review_read SET project_record_id=(SELECT record_id FROM project WHERE name=review_read.project)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=review_read.project)=1;
UPDATE doc SET project_record_id=(SELECT record_id FROM project WHERE name=doc.subject)
WHERE project_record_id IS NULL AND scope IN ('project','resume','canon','settings')
  AND (SELECT COUNT(*) FROM project WHERE name=doc.subject)=1;
UPDATE doc_revision SET project_record_id=(SELECT record_id FROM project WHERE name=doc_revision.subject)
WHERE project_record_id IS NULL AND scope IN ('project','resume','canon','settings')
  AND (SELECT COUNT(*) FROM project WHERE name=doc_revision.subject)=1;
UPDATE review SET project_record_id=(
  SELECT MIN(r.project_record_id)
  FROM review_lens rl JOIN run r ON r.record_id=rl.run_record_id
  WHERE rl.review_id=review.id
) WHERE project_record_id IS NULL
    AND EXISTS (
      SELECT 1 FROM review_lens rl JOIN run r ON r.record_id=rl.run_record_id
      WHERE rl.review_id=review.id AND r.project_record_id IS NOT NULL
    )
    AND 1=(
      SELECT COUNT(DISTINCT r.project_record_id)
      FROM review_lens rl JOIN run r ON r.record_id=rl.run_record_id
      WHERE rl.review_id=review.id AND r.project_record_id IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM review_lens rl JOIN run r ON r.record_id=rl.run_record_id
      WHERE rl.review_id=review.id AND r.project_record_id IS NULL
    );
-- /BACKFILL
