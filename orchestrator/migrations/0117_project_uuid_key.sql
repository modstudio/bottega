CREATE TABLE board_claim_project_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('task','path','resource')),
  subject_value TEXT NOT NULL,
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('operator','architect')),
  holder_session TEXT,
  note TEXT,
  run_id INTEGER REFERENCES run(id),
  duration_ms INTEGER NOT NULL,
  taken_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  lapses_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT CHECK (close_reason IN ('released','lapsed','run-ended','task-closed','taken-over')),
  superseded_by_claim_id INTEGER REFERENCES board_claim_project_uuid(id),
  record_id TEXT NOT NULL,
  CHECK ((holder_kind = 'operator' AND holder_session IS NULL) OR
         (holder_kind = 'architect' AND holder_session IS NOT NULL)),
  CHECK ((closed_at IS NULL AND close_reason IS NULL) OR
         (closed_at IS NOT NULL AND close_reason IS NOT NULL))
);
INSERT INTO board_claim_project_uuid
SELECT id,project,(SELECT record_id FROM project WHERE name=board_claim.project),
       subject_kind,subject_value,holder_kind,holder_session,note,run_id,duration_ms,
       taken_at,renewed_at,lapses_at,closed_at,close_reason,superseded_by_claim_id,record_id
FROM board_claim;
DROP TABLE board_claim;
ALTER TABLE board_claim_project_uuid RENAME TO board_claim;
CREATE INDEX board_claim_project_subject
  ON board_claim(project_record_id,subject_kind,subject_value,closed_at);
CREATE UNIQUE INDEX board_claim_record_id_unique ON board_claim(record_id);
CREATE INDEX board_claim_run ON board_claim(run_id,closed_at);
CREATE INDEX board_claim_superseded ON board_claim(superseded_by_claim_id);
--> statement-breakpoint
CREATE TABLE presence_project_uuid (
  session_id TEXT PRIMARY KEY CHECK (session_id <> 'operator'),
  harness TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'architect'),
  machine TEXT NOT NULL,
  project TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  cwd TEXT NOT NULL,
  current_task_key TEXT,
  last_seen TEXT NOT NULL,
  first_seen TEXT
);
INSERT INTO presence_project_uuid
SELECT session_id,harness,role,machine,project,
       (SELECT record_id FROM project WHERE name=presence.project),cwd,current_task_key,last_seen,first_seen
FROM presence;
DROP TABLE presence;
ALTER TABLE presence_project_uuid RENAME TO presence;
CREATE INDEX presence_last_seen ON presence(last_seen);
CREATE INDEX presence_project_record_id ON presence(project_record_id);
--> statement-breakpoint
CREATE TABLE worker_note_request_project_uuid (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000 AND instr(text, char(10)) = 0 AND instr(text, char(13)) = 0),
  file TEXT CHECK (file IS NULL OR length(file) BETWEEN 1 AND 1000),
  same_as TEXT CHECK (same_as IS NULL OR length(same_as) BETWEEN 1 AND 1000),
  requested_at TEXT NOT NULL, claimed_at TEXT, finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested','filed','refused')),
  note_record_id TEXT, note_label TEXT,
  candidate_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_ids)),
  candidate_labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_labels)),
  refusal_class TEXT CHECK (refusal_class IN ('anchor-refused','filing-refused','supervisor-closed')),
  detail TEXT, project TEXT,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL,
  CHECK ((status = 'requested' AND finished_at IS NULL AND note_record_id IS NULL AND note_label IS NULL AND refusal_class IS NULL) OR
         (status = 'filed' AND finished_at IS NOT NULL AND note_label IS NOT NULL AND refusal_class IS NULL) OR
         (status = 'refused' AND finished_at IS NOT NULL AND note_record_id IS NULL AND note_label IS NULL AND refusal_class IS NOT NULL))
);
INSERT INTO worker_note_request_project_uuid
SELECT id,run_id,text,file,same_as,requested_at,claimed_at,finished_at,status,note_record_id,note_label,
       candidate_ids,candidate_labels,refusal_class,detail,project,
       (SELECT record_id FROM project WHERE name=worker_note_request.project),record_id
FROM worker_note_request;
DROP TABLE worker_note_request;
ALTER TABLE worker_note_request_project_uuid RENAME TO worker_note_request;
CREATE INDEX worker_note_request_pending ON worker_note_request(run_id,status,claimed_at,id);
CREATE UNIQUE INDEX worker_note_request_record_id_unique ON worker_note_request(record_id);
CREATE INDEX worker_note_request_project_record_id ON worker_note_request(project_record_id);
--> statement-breakpoint
CREATE TABLE workflow_cursor_project_uuid (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  workflow_slug TEXT NOT NULL,
  mode_slug TEXT NOT NULL,
  workflow_key TEXT NOT NULL DEFAULT '',
  instance_id TEXT NOT NULL,
  session_id TEXT,
  workflow_version INTEGER NOT NULL,
  catalogue_version INTEGER NOT NULL,
  args TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  step_slug TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','awaiting-ruling','done','abandoned')),
  closed TEXT NOT NULL DEFAULT '[]',
  question TEXT,
  total_steps INTEGER NOT NULL CHECK (total_steps > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  autonomy TEXT,
  enforcement TEXT NOT NULL DEFAULT 'note-only' CHECK (enforcement IN ('note-only','floors')),
  record_id TEXT NOT NULL,
  UNIQUE (project_record_id,workflow_slug,mode_slug,workflow_key,instance_id)
);
INSERT INTO workflow_cursor_project_uuid
SELECT id,project,(SELECT record_id FROM project WHERE name=workflow_cursor.project),
       workflow_slug,mode_slug,workflow_key,instance_id,session_id,workflow_version,catalogue_version,
       args,ordinal,step_slug,state,closed,question,total_steps,created_at,updated_at,autonomy,enforcement,record_id
FROM workflow_cursor;
DROP TABLE workflow_cursor;
ALTER TABLE workflow_cursor_project_uuid RENAME TO workflow_cursor;
CREATE INDEX workflow_cursor_open_session ON workflow_cursor(session_id,project_record_id,state);
CREATE UNIQUE INDEX workflow_cursor_record_id_unique ON workflow_cursor(record_id);
--> statement-breakpoint
CREATE TABLE branch_landing_record_project_uuid (
  project TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  branch TEXT NOT NULL,
  tip TEXT NOT NULL,
  pr_number INTEGER NOT NULL CHECK (pr_number > 0),
  merge_commit TEXT,
  merged_at TEXT NOT NULL,
  recording_session TEXT,
  recorded_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (project,branch),
  UNIQUE (project_record_id,branch)
);
INSERT INTO branch_landing_record_project_uuid
SELECT project,(SELECT record_id FROM project WHERE name=branch_landing_record.project),branch,tip,
       pr_number,merge_commit,merged_at,recording_session,recorded_at,record_id
FROM branch_landing_record;
DROP TABLE branch_landing_record;
ALTER TABLE branch_landing_record_project_uuid RENAME TO branch_landing_record;
CREATE UNIQUE INDEX branch_landing_record_record_id_unique ON branch_landing_record(record_id);
--> statement-breakpoint
CREATE TABLE "run_project_uuid" (
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
  parent_run_id INTEGER REFERENCES run(id),
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
  close_out_outcome TEXT CHECK (
    close_out_outcome IS NULL OR
    close_out_outcome IN ('released','forgotten','held','live','absent','failed')
  ),
  close_out_detail TEXT, close_out_attempted_at TEXT, agent_pgid INTEGER,
  agent_start_time TEXT, keep_tree_until TEXT, keep_tree_reason TEXT, recipe_snapshot TEXT,
  record_id TEXT NOT NULL, started_by_user_id TEXT, task_record_id TEXT,
  gate_requests_closed INTEGER NOT NULL DEFAULT 0 CHECK (gate_requests_closed IN (0,1)),
  resource_teardown TEXT CHECK (resource_teardown IN ('pending','done'))
);
INSERT INTO "run_project_uuid" ("id","started_at","agent","job","repo","cwd","prompt_sha","prompt_bytes","prompt_head","label","lens","latency_ms","exit_code","output_bytes","output_path","prompt_path","vendor_tokens","vendor_cost_usd","probe","failure_kind","status","error","pid","session_id","retry_of","launch_cwd","launch_seed","launch_key","launch_base","no_failover","automatic_failover","route_reason","sandbox","branch","branch_kept","branch_kept_tip","worktree","worktree_source","vendor_session","base_commit","carry_happened","carry_base_commit","carry_tracked_paths","carry_untracked_paths","parent_run_id","turn","files_changed","changed_paths","lines_added","lines_removed","tests_ran","tests_passed","deviations","escalations","stack","model","run_token","evidence_excluded","outside_worktree_writes","input_tree","head_commit","review_ref","agent_pid","mcp","mcp_server","mcp_connected","mcp_error","mcp_trust_granted","mcp_trust_path","schema_path","docs_injected","doc_revisions","canon_sha","transport","pre_confinement","spec_sha","keep_tree","project_record_id","last_event_at","minted_branch","unreconciled","mcp_probe","confinement","review_provenance","provenance_status","work_preserved","close_out_outcome","close_out_detail","close_out_attempted_at","agent_pgid","agent_start_time","keep_tree_until","keep_tree_reason","recipe_snapshot","record_id","started_by_user_id","task_record_id","gate_requests_closed","resource_teardown")
SELECT "run"."id","run"."started_at","run"."agent","run"."job","run"."repo","run"."cwd","run"."prompt_sha","run"."prompt_bytes","run"."prompt_head","run"."label","run"."lens","run"."latency_ms","run"."exit_code","run"."output_bytes","run"."output_path","run"."prompt_path","run"."vendor_tokens","run"."vendor_cost_usd","run"."probe","run"."failure_kind","run"."status","run"."error","run"."pid","run"."session_id","run"."retry_of","run"."launch_cwd","run"."launch_seed","run"."launch_key","run"."launch_base","run"."no_failover","run"."automatic_failover","run"."route_reason","run"."sandbox","run"."branch","run"."branch_kept","run"."branch_kept_tip","run"."worktree","run"."worktree_source","run"."vendor_session","run"."base_commit","run"."carry_happened","run"."carry_base_commit","run"."carry_tracked_paths","run"."carry_untracked_paths","run"."parent_run_id","run"."turn","run"."files_changed","run"."changed_paths","run"."lines_added","run"."lines_removed","run"."tests_ran","run"."tests_passed","run"."deviations","run"."escalations","run"."stack","run"."model","run"."run_token","run"."evidence_excluded","run"."outside_worktree_writes","run"."input_tree","run"."head_commit","run"."review_ref","run"."agent_pid","run"."mcp","run"."mcp_server","run"."mcp_connected","run"."mcp_error","run"."mcp_trust_granted","run"."mcp_trust_path","run"."schema_path","run"."docs_injected","run"."doc_revisions","run"."canon_sha","run"."transport","run"."pre_confinement","run"."spec_sha","run"."keep_tree",(SELECT record_id FROM project WHERE id="run"."project_id"),"run"."last_event_at","run"."minted_branch","run"."unreconciled","run"."mcp_probe","run"."confinement","run"."review_provenance","run"."provenance_status","run"."work_preserved","run"."close_out_outcome","run"."close_out_detail","run"."close_out_attempted_at","run"."agent_pgid","run"."agent_start_time","run"."keep_tree_until","run"."keep_tree_reason","run"."recipe_snapshot","run"."record_id","run"."started_by_user_id","run"."task_record_id","run"."gate_requests_closed","run"."resource_teardown" FROM "run";
DROP TABLE "run";
ALTER TABLE "run_project_uuid" RENAME TO "run";
CREATE INDEX run_job_agent ON run(job, agent);
CREATE INDEX run_parent_turn ON run(parent_run_id, turn);
CREATE INDEX run_project_id ON run(project_record_id);
CREATE UNIQUE INDEX run_record_id_unique ON run(record_id);
--> statement-breakpoint
CREATE TABLE "canon_pack_project_uuid" (
  id INTEGER PRIMARY KEY, job TEXT NOT NULL, project TEXT, sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL, doc_count INTEGER NOT NULL, doc_revisions TEXT NOT NULL,
  compiled_at TEXT NOT NULL, findings INTEGER NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  canon_bytes INTEGER NOT NULL DEFAULT 0, doc_bytes INTEGER NOT NULL DEFAULT 0,
  record_id TEXT NOT NULL, UNIQUE(job, project)
);
INSERT INTO "canon_pack_project_uuid" ("id","job","project","sha256","bytes","doc_count","doc_revisions","compiled_at","findings","project_record_id","canon_bytes","doc_bytes","record_id")
SELECT "canon_pack"."id","canon_pack"."job","canon_pack"."project","canon_pack"."sha256","canon_pack"."bytes","canon_pack"."doc_count","canon_pack"."doc_revisions","canon_pack"."compiled_at","canon_pack"."findings",(SELECT record_id FROM project WHERE id="canon_pack"."project_id"),"canon_pack"."canon_bytes","canon_pack"."doc_bytes","canon_pack"."record_id" FROM "canon_pack";
DROP TABLE "canon_pack";
ALTER TABLE "canon_pack_project_uuid" RENAME TO "canon_pack";
CREATE UNIQUE INDEX canon_pack_address ON canon_pack(job, COALESCE(project, ''));
CREATE INDEX canon_pack_project_id ON canon_pack(project_record_id);
CREATE UNIQUE INDEX canon_pack_record_id_unique ON canon_pack(record_id);
--> statement-breakpoint
CREATE TABLE "doc_project_uuid" (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','stack','resume','canon','settings')),
  subject TEXT,
  slug TEXT NOT NULL CHECK (
    (scope = 'canon' AND length(slug) > 0 AND slug NOT GLOB '/*' AND slug NOT GLOB '*..*') OR
    (scope <> 'canon' AND length(slug) <= 64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*')
  ),
  title TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  body TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'inject' CHECK (delivery IN ('inject','demand')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  owner TEXT,
  audiences TEXT NOT NULL CHECK (json_valid(audiences) AND json_type(audiences) = 'array' AND json_array_length(audiences) > 0),
  parent_id INTEGER REFERENCES "doc"(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  replacement_slug TEXT,
  status TEXT NOT NULL DEFAULT 'current'
    CHECK (status IN ('draft','current','superseded','archived'))
    CHECK ((status = 'superseded') = (replacement_slug IS NOT NULL)),
  kind TEXT NOT NULL DEFAULT 'working' CHECK (kind IN ('working','article')),
  form TEXT CHECK (form IS NULL OR form IN ('feature','how-to','rule','model','overview','reference')),
  article_subject_id TEXT REFERENCES subject(id) ON DELETE RESTRICT,
  source_files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_files) AND json_type(source_files) = 'array'),
  checked_against_commit TEXT, summary TEXT,
  CHECK (
    (owner IS NOT NULL AND scope IN ('canon','settings') AND subject IS NULL) OR
    (owner IS NULL AND (
      (scope IN ('machine','global') AND subject IS NULL) OR
      (scope IN ('project','stack','agent','job','resume') AND subject IS NOT NULL) OR
      scope IN ('canon','settings')
    ))
  ),
  UNIQUE(scope, subject, slug)
);
INSERT INTO "doc_project_uuid" ("id","scope","subject","slug","title","project_record_id","body","delivery","created_at","updated_at","record_id","owner","audiences","parent_id","position","featured","replacement_slug","status","kind","form","article_subject_id","source_files","checked_against_commit","summary")
SELECT "doc"."id","doc"."scope","doc"."subject","doc"."slug","doc"."title",(SELECT record_id FROM project WHERE id="doc"."project_id"),"doc"."body","doc"."delivery","doc"."created_at","doc"."updated_at","doc"."record_id","doc"."owner","doc"."audiences","doc"."parent_id","doc"."position","doc"."featured","doc"."replacement_slug","doc"."status","doc"."kind","doc"."form","doc"."article_subject_id","doc"."source_files","doc"."checked_against_commit","doc"."summary" FROM "doc";
DROP TABLE "doc";
ALTER TABLE "doc_project_uuid" RENAME TO "doc";
CREATE UNIQUE INDEX doc_address ON doc(scope, COALESCE(subject, ''), COALESCE(owner, ''), slug);
CREATE INDEX doc_parent_id ON doc(parent_id);
CREATE INDEX doc_project_id ON doc(project_record_id);
CREATE UNIQUE INDEX doc_record_id ON doc(record_id);
CREATE INDEX doc_scope_subject ON doc(scope, subject);
--> statement-breakpoint
CREATE TABLE "doc_revision_project_uuid" (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','stack','resume','canon','settings')),
  subject TEXT,
  slug TEXT NOT NULL CHECK (
    (scope = 'canon' AND length(slug) > 0 AND slug NOT GLOB '/*' AND slug NOT GLOB '*..*') OR
    (scope <> 'canon' AND length(slug) <= 64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*')
  ),
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  op TEXT NOT NULL CHECK (op IN ('create','set','consume','delete','restore','import','backfill')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'inject' CHECK (delivery IN ('inject','demand')),
  author TEXT NOT NULL CHECK (length(trim(author)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  owner TEXT,
  audiences TEXT NOT NULL CHECK (json_valid(audiences) AND json_type(audiences) = 'array' AND json_array_length(audiences) > 0),
  parent_id INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  replacement_slug TEXT,
  status TEXT NOT NULL DEFAULT 'current'
    CHECK (status IN ('draft','current','superseded','archived'))
    CHECK ((status = 'superseded') = (replacement_slug IS NOT NULL)),
  kind TEXT NOT NULL DEFAULT 'working' CHECK (kind IN ('working','article')),
  form TEXT CHECK (form IS NULL OR form IN ('feature','how-to','rule','model','overview','reference')),
  article_subject_id TEXT REFERENCES subject(id) ON DELETE RESTRICT,
  related_subject_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related_subject_ids) AND json_type(related_subject_ids) = 'array'),
  source_files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_files) AND json_type(source_files) = 'array'),
  checked_against_commit TEXT, summary TEXT,
  CHECK (
    (owner IS NOT NULL AND scope IN ('canon','settings') AND subject IS NULL) OR
    (owner IS NULL AND (
      (scope IN ('machine','global') AND subject IS NULL) OR
      (scope IN ('project','stack','agent','job','resume') AND subject IS NOT NULL) OR
      scope IN ('canon','settings')
    ))
  )
);
INSERT INTO "doc_revision_project_uuid" ("id","doc_id","scope","subject","slug","project_record_id","op","title","body","delivery","author","reason","session_id","at","record_id","owner","audiences","parent_id","position","featured","replacement_slug","status","kind","form","article_subject_id","related_subject_ids","source_files","checked_against_commit","summary")
SELECT "doc_revision"."id","doc_revision"."doc_id","doc_revision"."scope","doc_revision"."subject","doc_revision"."slug",(SELECT record_id FROM project WHERE id="doc_revision"."project_id"),"doc_revision"."op","doc_revision"."title","doc_revision"."body","doc_revision"."delivery","doc_revision"."author","doc_revision"."reason","doc_revision"."session_id","doc_revision"."at","doc_revision"."record_id","doc_revision"."owner","doc_revision"."audiences","doc_revision"."parent_id","doc_revision"."position","doc_revision"."featured","doc_revision"."replacement_slug","doc_revision"."status","doc_revision"."kind","doc_revision"."form","doc_revision"."article_subject_id","doc_revision"."related_subject_ids","doc_revision"."source_files","doc_revision"."checked_against_commit","doc_revision"."summary" FROM "doc_revision";
DROP TABLE "doc_revision";
ALTER TABLE "doc_revision_project_uuid" RENAME TO "doc_revision";
CREATE INDEX doc_revision_address ON doc_revision(scope, COALESCE(subject, ''), COALESCE(owner, ''), slug, id);
CREATE INDEX doc_revision_doc ON doc_revision(doc_id, id);
CREATE INDEX doc_revision_project_id ON doc_revision(project_record_id);
--> statement-breakpoint
CREATE TABLE "landing_project_uuid" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  branch TEXT NOT NULL,
  tip TEXT,
  trunk_before TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'queued','running','landed','refused','install_failed','rebase_required'
  )),
  error TEXT,
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  path_set TEXT CHECK (path_set IS NULL OR json_valid(path_set)),
  requested_at TEXT,
  steps TEXT CHECK (steps IS NULL OR json_valid(steps)),
  causing_landing_id INTEGER,
  claim_pid INTEGER,
  claim_session TEXT,
  heartbeat_delivered_at TEXT,
  record_id TEXT NOT NULL
);
INSERT INTO "landing_project_uuid" ("id","project","project_record_id","branch","tip","trunk_before","status","error","session_id","started_at","finished_at","path_set","requested_at","steps","causing_landing_id","claim_pid","claim_session","heartbeat_delivered_at","record_id")
SELECT "landing"."id","landing"."project",(SELECT record_id FROM project WHERE id="landing"."project_id"),"landing"."branch","landing"."tip","landing"."trunk_before","landing"."status","landing"."error","landing"."session_id","landing"."started_at","landing"."finished_at","landing"."path_set","landing"."requested_at","landing"."steps","landing"."causing_landing_id","landing"."claim_pid","landing"."claim_session","landing"."heartbeat_delivered_at","landing"."record_id" FROM "landing";
DROP TABLE "landing";
ALTER TABLE "landing_project_uuid" RENAME TO "landing";
CREATE INDEX landing_project_id ON landing(project_record_id);
CREATE INDEX landing_project_started ON landing(project, started_at);
CREATE INDEX landing_project_status ON landing(project, status);
CREATE UNIQUE INDEX landing_record_id_unique ON landing(record_id);
--> statement-breakpoint
CREATE TABLE "landing_override_project_uuid" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  branch TEXT NOT NULL,
  tip TEXT NOT NULL,
  tree TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL,
  patch_id TEXT,
  path_set TEXT CHECK (path_set IS NULL OR json_valid(path_set))
);
INSERT INTO "landing_override_project_uuid" ("id","project","branch","tip","tree","reason","session_id","at","project_record_id","record_id","patch_id","path_set")
SELECT "landing_override"."id","landing_override"."project","landing_override"."branch","landing_override"."tip","landing_override"."tree","landing_override"."reason","landing_override"."session_id","landing_override"."at",(SELECT record_id FROM project WHERE id="landing_override"."project_id"),"landing_override"."record_id","landing_override"."patch_id","landing_override"."path_set" FROM "landing_override";
DROP TABLE "landing_override";
ALTER TABLE "landing_override_project_uuid" RENAME TO "landing_override";
CREATE INDEX landing_override_project_id ON landing_override(project_record_id);
CREATE UNIQUE INDEX landing_override_record_id_unique ON landing_override(record_id);
--> statement-breakpoint
CREATE TABLE "landing_review_carry_project_uuid" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  branch TEXT NOT NULL,
  tip TEXT NOT NULL,
  tree TEXT NOT NULL,
  review_id INTEGER NOT NULL REFERENCES review(id),
  reviewed_commit TEXT NOT NULL,
  reviewed_tree TEXT NOT NULL,
  patch_id TEXT NOT NULL,
  old_base TEXT NOT NULL,
  new_base TEXT NOT NULL,
  session_id TEXT,
  at TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL
);
INSERT INTO "landing_review_carry_project_uuid" ("id","project","branch","tip","tree","review_id","reviewed_commit","reviewed_tree","patch_id","old_base","new_base","session_id","at","project_record_id","record_id")
SELECT "landing_review_carry"."id","landing_review_carry"."project","landing_review_carry"."branch","landing_review_carry"."tip","landing_review_carry"."tree","landing_review_carry"."review_id","landing_review_carry"."reviewed_commit","landing_review_carry"."reviewed_tree","landing_review_carry"."patch_id","landing_review_carry"."old_base","landing_review_carry"."new_base","landing_review_carry"."session_id","landing_review_carry"."at",(SELECT record_id FROM project WHERE id="landing_review_carry"."project_id"),"landing_review_carry"."record_id" FROM "landing_review_carry";
DROP TABLE "landing_review_carry";
ALTER TABLE "landing_review_carry_project_uuid" RENAME TO "landing_review_carry";
CREATE INDEX landing_review_carry_project_id ON landing_review_carry(project_record_id);
CREATE UNIQUE INDEX landing_review_carry_record_id_unique ON landing_review_carry(record_id);
--> statement-breakpoint
CREATE TABLE "landing_triage_snapshot_project_uuid" (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id     TEXT NOT NULL UNIQUE,
  project       TEXT NOT NULL,
  project_record_id    TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  branch        TEXT NOT NULL,
  tip           TEXT NOT NULL,
  tree          TEXT NOT NULL,
  pr_number     INTEGER CHECK (pr_number > 0),
  review_ids    TEXT NOT NULL CHECK (json_valid(review_ids)),
  patch_id      TEXT NOT NULL,
  tier          INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  lens_rounds   INTEGER NOT NULL CHECK (lens_rounds >= 0),
  finding_count INTEGER NOT NULL CHECK (finding_count >= 0),
  override_id   INTEGER REFERENCES landing_override(id),
  session_id    TEXT,
  at            TEXT NOT NULL, admission_path TEXT NOT NULL DEFAULT 'exact_review'
  CHECK (admission_path IN ('exact_review','architect_read')), read_id INTEGER REFERENCES review_read(id),
  UNIQUE (project, branch, tip)
);
INSERT INTO "landing_triage_snapshot_project_uuid" ("id","record_id","project","project_record_id","branch","tip","tree","pr_number","review_ids","patch_id","tier","lens_rounds","finding_count","override_id","session_id","at","admission_path","read_id")
SELECT "landing_triage_snapshot"."id","landing_triage_snapshot"."record_id","landing_triage_snapshot"."project",(SELECT record_id FROM project WHERE id="landing_triage_snapshot"."project_id"),"landing_triage_snapshot"."branch","landing_triage_snapshot"."tip","landing_triage_snapshot"."tree","landing_triage_snapshot"."pr_number","landing_triage_snapshot"."review_ids","landing_triage_snapshot"."patch_id","landing_triage_snapshot"."tier","landing_triage_snapshot"."lens_rounds","landing_triage_snapshot"."finding_count","landing_triage_snapshot"."override_id","landing_triage_snapshot"."session_id","landing_triage_snapshot"."at","landing_triage_snapshot"."admission_path","landing_triage_snapshot"."read_id" FROM "landing_triage_snapshot";
DROP TABLE "landing_triage_snapshot";
ALTER TABLE "landing_triage_snapshot_project_uuid" RENAME TO "landing_triage_snapshot";
CREATE INDEX landing_triage_snapshot_pr ON landing_triage_snapshot(project, pr_number);
CREATE INDEX landing_triage_snapshot_project_id ON landing_triage_snapshot(project_record_id);
--> statement-breakpoint
CREATE TABLE "main_stack_activity_project_uuid" (
  project_record_id TEXT PRIMARY KEY REFERENCES project(record_id) ON DELETE CASCADE,
  last_ensured_at TEXT NOT NULL
);
INSERT INTO "main_stack_activity_project_uuid" ("project_record_id","last_ensured_at")
SELECT (SELECT record_id FROM project WHERE id="main_stack_activity"."project_id"),"main_stack_activity"."last_ensured_at" FROM "main_stack_activity";
DROP TABLE "main_stack_activity";
ALTER TABLE "main_stack_activity_project_uuid" RENAME TO "main_stack_activity";
--> statement-breakpoint
CREATE TABLE "port_pair_project_uuid" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE RESTRICT,
  target_project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  CHECK (source_project_record_id <> target_project_record_id),
  UNIQUE (source_project_record_id, target_project_record_id)
);
INSERT INTO "port_pair_project_uuid" ("id","source_project_record_id","target_project_record_id","created_at","record_id")
SELECT "port_pair"."id",(SELECT record_id FROM project WHERE id="port_pair"."source_project_id"),(SELECT record_id FROM project WHERE id="port_pair"."target_project_id"),"port_pair"."created_at","port_pair"."record_id" FROM "port_pair";
DROP TABLE "port_pair";
ALTER TABLE "port_pair_project_uuid" RENAME TO "port_pair";
CREATE UNIQUE INDEX port_pair_record_id_unique ON port_pair(record_id);
CREATE INDEX port_pair_target ON port_pair(target_project_record_id);
--> statement-breakpoint
CREATE TABLE "port_ref_project_uuid" (
  task_key TEXT NOT NULL,
  target_project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE RESTRICT,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  record_id TEXT NOT NULL,
  PRIMARY KEY (target_project_record_id, task_key)
);
INSERT INTO "port_ref_project_uuid" ("task_key","target_project_record_id","note","created_at","resolved_at","record_id")
SELECT "port_ref"."task_key",(SELECT record_id FROM project WHERE id="port_ref"."target_project_id"),"port_ref"."note","port_ref"."created_at","port_ref"."resolved_at","port_ref"."record_id" FROM "port_ref";
DROP TABLE "port_ref";
ALTER TABLE "port_ref_project_uuid" RENAME TO "port_ref";
CREATE UNIQUE INDEX port_ref_record_id_unique ON port_ref(record_id);
--> statement-breakpoint
CREATE TABLE "port_ref_source_project_uuid" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL,
  target_project_record_id TEXT NOT NULL,
  source_project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE RESTRICT,
  commits TEXT NOT NULL,
  paths TEXT NOT NULL,
  note TEXT NOT NULL,
  record_id TEXT NOT NULL,
  FOREIGN KEY (target_project_record_id, task_key)
    REFERENCES port_ref(target_project_record_id, task_key) ON DELETE CASCADE,
  UNIQUE (target_project_record_id, task_key, source_project_record_id)
);
INSERT INTO "port_ref_source_project_uuid" ("id","task_key","target_project_record_id","source_project_record_id","commits","paths","note","record_id")
SELECT "port_ref_source"."id","port_ref_source"."task_key",(SELECT record_id FROM project WHERE id="port_ref_source"."target_project_id"),(SELECT record_id FROM project WHERE id="port_ref_source"."source_project_id"),"port_ref_source"."commits","port_ref_source"."paths","port_ref_source"."note","port_ref_source"."record_id" FROM "port_ref_source";
DROP TABLE "port_ref_source";
ALTER TABLE "port_ref_source_project_uuid" RENAME TO "port_ref_source";
CREATE UNIQUE INDEX port_ref_source_record_id_unique ON port_ref_source(record_id);
CREATE INDEX port_ref_source_task ON port_ref_source(target_project_record_id,task_key);
--> statement-breakpoint
CREATE TABLE "project_lens_profile_project_uuid" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE CASCADE,
  lens_id TEXT REFERENCES lens(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK(axis IN ('framework','architecture')),
  profile_name TEXT NOT NULL,
  selected_version INTEGER CHECK(selected_version IS NULL OR selected_version > 0),
  record_id TEXT NOT NULL
);
INSERT INTO "project_lens_profile_project_uuid" ("id","project_record_id","lens_id","axis","profile_name","selected_version","record_id")
SELECT "project_lens_profile"."id",(SELECT record_id FROM project WHERE id="project_lens_profile"."project_id"),"project_lens_profile"."lens_id","project_lens_profile"."axis","project_lens_profile"."profile_name","project_lens_profile"."selected_version","project_lens_profile"."record_id" FROM "project_lens_profile";
DROP TABLE "project_lens_profile";
ALTER TABLE "project_lens_profile_project_uuid" RENAME TO "project_lens_profile";
CREATE UNIQUE INDEX project_lens_profile_global
  ON project_lens_profile(project_record_id,axis) WHERE lens_id IS NULL;
CREATE UNIQUE INDEX project_lens_profile_record_id_unique ON project_lens_profile(record_id);
CREATE UNIQUE INDEX project_lens_profile_specific
  ON project_lens_profile(project_record_id,lens_id,axis) WHERE lens_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "release_ledger_project_uuid" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  rung TEXT NOT NULL,
  candidate_commit TEXT NOT NULL,
  live_commit_before TEXT,
  rollback INTEGER NOT NULL CHECK (rollback IN (0,1)),
  rollback_reason TEXT,
  actor TEXT NOT NULL,
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  output_tail TEXT NOT NULL DEFAULT '',
  live_commit_after TEXT,
  live_matches_candidate INTEGER CHECK (live_matches_candidate IN (0,1)),
  warning TEXT,
  record_id TEXT NOT NULL, project_record_id TEXT REFERENCES project(record_id),
  CHECK ((rollback = 1 AND rollback_reason IS NOT NULL) OR (rollback = 0 AND rollback_reason IS NULL)),
  CHECK ((finished_at IS NULL AND exit_code IS NULL) OR (finished_at IS NOT NULL AND exit_code IS NOT NULL))
);
INSERT INTO "release_ledger_project_uuid" ("id","project","rung","candidate_commit","live_commit_before","rollback","rollback_reason","actor","session_id","started_at","finished_at","exit_code","output_tail","live_commit_after","live_matches_candidate","warning","record_id","project_record_id")
SELECT "release_ledger"."id","release_ledger"."project","release_ledger"."rung","release_ledger"."candidate_commit","release_ledger"."live_commit_before","release_ledger"."rollback","release_ledger"."rollback_reason","release_ledger"."actor","release_ledger"."session_id","release_ledger"."started_at","release_ledger"."finished_at","release_ledger"."exit_code","release_ledger"."output_tail","release_ledger"."live_commit_after","release_ledger"."live_matches_candidate","release_ledger"."warning","release_ledger"."record_id",(SELECT record_id FROM project WHERE id="release_ledger"."project_id") FROM "release_ledger";
DROP TABLE "release_ledger";
ALTER TABLE "release_ledger_project_uuid" RENAME TO "release_ledger";
CREATE INDEX release_ledger_project_rung_started ON release_ledger(project,rung,started_at DESC,id DESC);
CREATE UNIQUE INDEX release_ledger_record_id ON release_ledger(record_id);
--> statement-breakpoint
CREATE TABLE "resource_claim_project_uuid" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_run_id INTEGER NOT NULL REFERENCES run(id),
  run_id INTEGER NOT NULL REFERENCES run(id),
  project_record_id TEXT REFERENCES project(record_id),
  kind TEXT NOT NULL CHECK (kind IN ('worktree','branch','retained_ref','sandbox_dir','trust_entry','port','database','index','string')),
  allocation_key TEXT NOT NULL,
  identity TEXT,
  label TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed','released','retained','forgotten','absent')),
  claimed_at TEXT NOT NULL,
  settled_at TEXT,
  settled_detail TEXT,
  record_id TEXT NOT NULL
);
INSERT INTO "resource_claim_project_uuid" ("id","root_run_id","run_id","project_record_id","kind","allocation_key","identity","label","state","claimed_at","settled_at","settled_detail","record_id")
SELECT "resource_claim"."id","resource_claim"."root_run_id","resource_claim"."run_id",(SELECT record_id FROM project WHERE id="resource_claim"."project_id"),"resource_claim"."kind","resource_claim"."allocation_key","resource_claim"."identity","resource_claim"."label","resource_claim"."state","resource_claim"."claimed_at","resource_claim"."settled_at","resource_claim"."settled_detail","resource_claim"."record_id" FROM "resource_claim";
DROP TABLE "resource_claim";
ALTER TABLE "resource_claim_project_uuid" RENAME TO "resource_claim";
CREATE UNIQUE INDEX resource_claim_one_live_allocation ON resource_claim(kind, allocation_key) WHERE state='claimed';
CREATE UNIQUE INDEX resource_claim_record_id_unique ON resource_claim(record_id);
--> statement-breakpoint
CREATE TABLE "review_project_uuid" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL,
  completed_at TEXT,
  tier INTEGER,
  tier_risk INTEGER,
  tier_size INTEGER,
  tier_reasons TEXT,
  tier_reason TEXT,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  patch_id TEXT,
  path_set TEXT,
  commit_message TEXT,
  outdated_at TEXT,
  outdated_reason TEXT,
  record_id TEXT NOT NULL
);
INSERT INTO "review_project_uuid" ("id","recorded_at","completed_at","tier","tier_risk","tier_size","tier_reasons","tier_reason","project_record_id","patch_id","path_set","commit_message","outdated_at","outdated_reason","record_id")
SELECT "review"."id","review"."recorded_at","review"."completed_at","review"."tier","review"."tier_risk","review"."tier_size","review"."tier_reasons","review"."tier_reason",(SELECT record_id FROM project WHERE id="review"."project_id"),"review"."patch_id","review"."path_set","review"."commit_message","review"."outdated_at","review"."outdated_reason","review"."record_id" FROM "review";
DROP TABLE "review";
ALTER TABLE "review_project_uuid" RENAME TO "review";
CREATE INDEX review_project_id ON review(project_record_id);
CREATE UNIQUE INDEX review_record_id_unique ON review(record_id);
--> statement-breakpoint
CREATE TABLE "review_read_project_uuid" (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id   TEXT NOT NULL UNIQUE,
  project     TEXT NOT NULL,
  project_record_id  TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  branch      TEXT NOT NULL,
  tip         TEXT NOT NULL,
  patch_id    TEXT NOT NULL,
  path_set    TEXT NOT NULL CHECK (json_valid(path_set)),
  tier        INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  note        TEXT NOT NULL CHECK (length(trim(note)) > 0),
  session_id  TEXT,
  recorded_at TEXT NOT NULL
);
INSERT INTO "review_read_project_uuid" ("id","record_id","project","project_record_id","branch","tip","patch_id","path_set","tier","note","session_id","recorded_at")
SELECT "review_read"."id","review_read"."record_id","review_read"."project",(SELECT record_id FROM project WHERE id="review_read"."project_id"),"review_read"."branch","review_read"."tip","review_read"."patch_id","review_read"."path_set","review_read"."tier","review_read"."note","review_read"."session_id","review_read"."recorded_at" FROM "review_read";
DROP TABLE "review_read";
ALTER TABLE "review_read_project_uuid" RENAME TO "review_read";
CREATE INDEX review_read_change_group ON review_read(project, branch, patch_id, path_set);
--> statement-breakpoint
CREATE TABLE "subject_project_uuid" (
  id TEXT PRIMARY KEY,
  project_record_id TEXT NOT NULL REFERENCES project(record_id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  definition TEXT NOT NULL CHECK (
    length(trim(definition)) > 0
    AND instr(definition, char(10)) = 0
    AND instr(definition, char(13)) = 0
  ),
  position INTEGER NOT NULL CHECK (position >= 0),
  parent_id TEXT REFERENCES subject(id) ON DELETE RESTRICT,
  retired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
INSERT INTO "subject_project_uuid" ("id","project_record_id","name","definition","position","parent_id","retired_at","created_at","updated_at")
SELECT "subject"."id",(SELECT record_id FROM project WHERE id="subject"."project_id"),"subject"."name","subject"."definition","subject"."position","subject"."parent_id","subject"."retired_at","subject"."created_at","subject"."updated_at" FROM "subject";
DROP TABLE "subject";
ALTER TABLE "subject_project_uuid" RENAME TO "subject";
CREATE UNIQUE INDEX subject_live_name ON subject(project_record_id, name) WHERE retired_at IS NULL;
CREATE INDEX subject_parent_id ON subject(parent_id);
CREATE INDEX subject_project_position ON subject(project_record_id, position, id);
--> statement-breakpoint
CREATE TABLE project_project_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  stack TEXT,
  canon INTEGER NOT NULL DEFAULT 1,
  settings TEXT,
  retired_at TEXT
);
INSERT INTO project_project_uuid (record_id,name,path,stack,canon,settings,retired_at)
SELECT record_id,name,path,stack,canon,settings,retired_at FROM project;
DROP TABLE project;
ALTER TABLE project_project_uuid RENAME TO project;
--> statement-breakpoint
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
  SELECT MIN(r.project_record_id) FROM review_lens rl JOIN run r ON r.id=rl.run_id
   WHERE rl.review_id=review.id
) WHERE project_record_id IS NULL
    AND EXISTS (SELECT 1 FROM review_lens rl JOIN run r ON r.id=rl.run_id
                 WHERE rl.review_id=review.id AND r.project_record_id IS NOT NULL)
    AND 1=(SELECT COUNT(DISTINCT r.project_record_id) FROM review_lens rl JOIN run r ON r.id=rl.run_id
            WHERE rl.review_id=review.id AND r.project_record_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM review_lens rl JOIN run r ON r.id=rl.run_id
                     WHERE rl.review_id=review.id AND r.project_record_id IS NULL);
-- /BACKFILL


