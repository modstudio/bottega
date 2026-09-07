-- Hand-written baseline from trunk's canonical sqlite_master DDL.
-- Drizzle Kit 0.31.10 does not preserve SQLite table UNIQUE constraints or
-- expression indexes, so future migrations for this store are hand-written SQL.
CREATE TABLE blocker (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id   INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      at       TEXT NOT NULL,
      what     TEXT NOT NULL,
      why      TEXT,
      impact   TEXT,
      -- 'declared' came from the worker's structured reply; 'detected' was
      -- recognised in its prose. Kept apart for the same reason measured and
      -- claimed facts are: one is the worker's own account and the other is our
      -- reading of it, and a reader deserves to know which.
      source   TEXT NOT NULL CHECK (source IN ('declared','detected')),
      -- A stable name for the KIND of blocker, so recurrence is countable
      -- across runs, agents and projects. That count is the whole point: one
      -- denied socket is an anecdote, forty is a machine to fix.
      kind     TEXT
    );
--> statement-breakpoint
CREATE TABLE calibration (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      delivery   TEXT NOT NULL CHECK (delivery IN ('none','partial','full')),
      quality    TEXT CHECK (quality IN ('wrong','mixed','right')),
      fidelity   TEXT CHECK (fidelity IS NULL OR fidelity IN ('drifted','partial','faithful')),
      at         TEXT NOT NULL,
      session_id TEXT,
      CHECK ((delivery = 'none') = (quality IS NULL))
    );
--> statement-breakpoint
CREATE TABLE canon_eval (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT NOT NULL,
      run_id     INTEGER NOT NULL REFERENCES run(id),
      canon_sha  TEXT NOT NULL,
      agent      TEXT NOT NULL,
      model      TEXT,
      pass       INTEGER NOT NULL,
      why        TEXT NOT NULL,
      at         TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE canon_pack (
      id            INTEGER PRIMARY KEY,
      job           TEXT NOT NULL,
      project       TEXT,
      sha256        TEXT NOT NULL,
      bytes         INTEGER NOT NULL,
      doc_count     INTEGER NOT NULL,
      doc_revisions TEXT NOT NULL,
      compiled_at   TEXT NOT NULL,
      findings      INTEGER NOT NULL,
      UNIQUE(job, project)
    );
--> statement-breakpoint
CREATE TABLE compared_pair (
      run_a_id   INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      run_b_id   INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      compared_at TEXT NOT NULL,
      PRIMARY KEY (run_a_id, run_b_id),
      CHECK (run_a_id < run_b_id)
    );
--> statement-breakpoint
CREATE TABLE doc (
      id         INTEGER PRIMARY KEY,
      scope      TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','resume')),
      subject    TEXT,
      slug       TEXT NOT NULL CHECK (
                   length(slug) <= 64 AND
                   slug GLOB '[a-z0-9]*' AND
                   slug NOT GLOB '*[^a-z0-9-]*'
                 ),
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      delivery   TEXT NOT NULL DEFAULT 'inject' CHECK (delivery IN ('inject','demand')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((scope IN ('machine','global') AND subject IS NULL) OR
             (scope IN ('project','agent','job','resume') AND subject IS NOT NULL)),
      UNIQUE(scope, subject, slug)
    );
--> statement-breakpoint
CREATE TABLE doc_revision (
      id         INTEGER PRIMARY KEY,
      doc_id     INTEGER NOT NULL,
      scope      TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','resume')),
      subject    TEXT,
      slug       TEXT NOT NULL CHECK (
                   length(slug) <= 64 AND
                   slug GLOB '[a-z0-9]*' AND
                   slug NOT GLOB '*[^a-z0-9-]*'
                 ),
      op         TEXT NOT NULL CHECK (op IN ('create','set','consume','delete','restore','import','backfill')),
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      delivery   TEXT NOT NULL DEFAULT 'inject' CHECK (delivery IN ('inject','demand')),
      author     TEXT NOT NULL CHECK (length(trim(author)) > 0),
      reason     TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      session_id TEXT,
      at         TEXT NOT NULL,
      CHECK ((scope IN ('machine','global') AND subject IS NULL) OR
             (scope IN ('project','agent','job','resume') AND subject IS NOT NULL))
    );
--> statement-breakpoint
CREATE TABLE duel (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      job           TEXT NOT NULL,
      winner_run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      loser_run_id  INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      session_id    TEXT,
      at            TEXT NOT NULL,
      CHECK (winner_run_id <> loser_run_id),
      UNIQUE (winner_run_id, loser_run_id)
    );
--> statement-breakpoint
CREATE TABLE landing_override (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      branch TEXT NOT NULL,
      tip TEXT NOT NULL,
      tree TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      session_id TEXT,
      at TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE landing_review_carry (
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
      at TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE metric (
      day            TEXT PRIMARY KEY,
      claude_tokens  INTEGER NOT NULL,
      cache_read     INTEGER NOT NULL,
      messages       INTEGER NOT NULL,
      tasks          INTEGER NOT NULL,
      -- Spend on the canon repos vs everywhere else. Work outside them ships no
      -- task key, so counting it against a canon denominator inflates the ratio
      -- against work it never touched.
      canon_tokens   INTEGER NOT NULL DEFAULT 0,
      other_tokens   INTEGER NOT NULL DEFAULT 0,
      -- Denominators. No single one is trustworthy, so the ratio is reported
      -- under several and agreement between them is the signal.
      commits        INTEGER NOT NULL DEFAULT 0,
      files          INTEGER NOT NULL DEFAULT 0,
      lines_product  INTEGER NOT NULL DEFAULT 0,
      lines_test     INTEGER NOT NULL DEFAULT 0,
      lines_docs     INTEGER NOT NULL DEFAULT 0,
      lines_config   INTEGER NOT NULL DEFAULT 0,
      lines_generated INTEGER NOT NULL DEFAULT 0,
      collected_at   TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE monitor_condition (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      invocation_id   INTEGER NOT NULL REFERENCES monitor_invocation(id) ON DELETE CASCADE,
      kind             TEXT NOT NULL,
      subject          TEXT NOT NULL,
      condition_since  TEXT,
      age_ms           INTEGER,
      detail           TEXT NOT NULL,
      action           TEXT NOT NULL,
      issue_key        TEXT,
      severity         TEXT CHECK (severity IS NULL OR severity IN ('informational','attention')),
      UNIQUE(invocation_id, kind, subject)
    );
--> statement-breakpoint
CREATE TABLE monitor_invocation (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      trigger     TEXT NOT NULL CHECK (trigger IN ('invoked','backstop')),
      findings    INTEGER,
      errors      INTEGER
    );
--> statement-breakpoint
CREATE TABLE port_baseline (
      pair_id       INTEGER PRIMARY KEY REFERENCES port_pair(id) ON DELETE CASCADE,
      source_commit TEXT,
      scanned_at    TEXT,
      CHECK ((source_commit IS NULL) = (scanned_at IS NULL))
    );
--> statement-breakpoint
CREATE TABLE port_doctrine (
      number     INTEGER PRIMARY KEY CHECK (number > 0),
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      retired_at TEXT
    );
--> statement-breakpoint
CREATE TABLE port_pair (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      source_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
      target_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
      created_at        TEXT NOT NULL,
      CHECK (source_project_id <> target_project_id),
      UNIQUE (source_project_id, target_project_id)
    );
--> statement-breakpoint
CREATE TABLE port_ref (
      task_key          TEXT PRIMARY KEY,
      target_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
      note              TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      resolved_at       TEXT
    );
--> statement-breakpoint
CREATE TABLE port_ref_source (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key          TEXT NOT NULL REFERENCES port_ref(task_key) ON DELETE CASCADE,
      source_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
      commits           TEXT NOT NULL,
      paths             TEXT NOT NULL,
      note              TEXT NOT NULL,
      UNIQUE (task_key, source_project_id)
    );
--> statement-breakpoint
CREATE TABLE port_skip (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pair_id    INTEGER NOT NULL REFERENCES port_pair(id) ON DELETE CASCADE,
      candidate  TEXT NOT NULL,
      reason     TEXT NOT NULL,
      skipped_at TEXT NOT NULL,
      UNIQUE (pair_id, candidate)
    );
--> statement-breakpoint
CREATE TABLE project (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL UNIQUE,
      path     TEXT NOT NULL,
      -- Coarse and SHARED on purpose: its job is to be the same string for two
      -- projects an agent would find similar, so evidence about one is evidence
      -- about the other. A precise per-project label would be an id with extra
      -- steps.
      stack    TEXT,
      canon    INTEGER NOT NULL DEFAULT 1,
      -- A blob, because what a project must declare is not knowable in advance
      -- — a tracker's status vocabulary, a trunk branch name, a colour — and
      -- each of those as a column is another thing the code has to know about.
      settings TEXT
    );
--> statement-breakpoint
CREATE TABLE question (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id      INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      asked_at    TEXT NOT NULL,
      question    TEXT NOT NULL,
      -- What the worker thinks the choices are, and which it would take. Asked
      -- for because a question with no proposed answer makes the architect do
      -- the reading the delegation was meant to avoid — and because a worker
      -- that can name the options has usually understood the problem, which is
      -- itself worth seeing.
      options     TEXT,
      recommendation TEXT,
      why         TEXT,
      answer      TEXT,
      answered_at TEXT,
      -- Which session ruled. Same reasoning as score.scored_by: a ruling is a
      -- judgement, and an unattributed judgement cannot be audited.
      answered_by TEXT,
      -- Set in the ruling transaction and cleared only when a resumed or
      -- replacement turn is claimed. A non-NULL value is a durable retry signal.
      delivery_pending_at TEXT
    );
--> statement-breakpoint
CREATE TABLE review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at TEXT NOT NULL,
      completed_at TEXT,
      tier INTEGER,
      tier_risk INTEGER,
      tier_size INTEGER,
      tier_reasons TEXT,
      tier_reason TEXT
    );
--> statement-breakpoint
CREATE TABLE review_finding (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
      review_lens_id INTEGER NOT NULL REFERENCES review_lens(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      severity TEXT NOT NULL,
      location TEXT NOT NULL,
      evidence TEXT NOT NULL,
      proposed_correction TEXT NOT NULL,
      disposition TEXT CHECK (disposition IS NULL OR disposition IN ('accepted','modified','rejected','skipped')),
      rejection_category TEXT,
      triaged_severity TEXT CHECK (triaged_severity IS NULL OR triaged_severity IN ('critical','high','medium','low')),
      triaged_at TEXT,
      UNIQUE(review_id, ordinal),
      CHECK (disposition = 'rejected' OR rejection_category IS NULL)
    );
--> statement-breakpoint
CREATE TABLE review_lens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
      run_id INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
      lens TEXT NOT NULL,
      agent TEXT NOT NULL,
      model TEXT,
      tree_inspected TEXT,
      reviewed_tree TEXT,
      standards_read TEXT NOT NULL,
      files_covered TEXT NOT NULL,
      commands_run TEXT NOT NULL,
      could_not_verify TEXT NOT NULL,
      reproduced TEXT CHECK (reproduced IS NULL OR reproduced IN ('none','some','all')),
      coverage TEXT CHECK (coverage IS NULL OR coverage IN ('empty','partial','adequate')),
      limits TEXT CHECK (limits IS NULL OR limits IN ('named','absent')),
      overlap TEXT CHECK (overlap IS NULL OR overlap IN ('unique','shared','none','alone'))
    );
--> statement-breakpoint
CREATE TABLE run (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    TEXT NOT NULL,
      agent         TEXT NOT NULL,
      job           TEXT NOT NULL,
      repo          TEXT,
      cwd           TEXT,
      prompt_sha    TEXT NOT NULL,
      prompt_bytes  INTEGER NOT NULL,
      prompt_head   TEXT NOT NULL,
      label         TEXT,
      -- Stable calibration identity for findings-producing review jobs.
      lens          TEXT,
      latency_ms    INTEGER,
      exit_code     INTEGER,
      output_bytes  INTEGER,
      output_path   TEXT,
      prompt_path   TEXT,
      vendor_tokens INTEGER,
      -- only grok reports what a call cost; null everywhere else
      vendor_cost_usd REAL,
      -- a calibration probe: scored like any run, but never counted as evidence
      probe         INTEGER NOT NULL DEFAULT 0,
      -- Classified by failure.ts; quota, auth and unreachable need a person.
      failure_kind  TEXT,
      -- Born running, not ok. A row is inserted before the agent is spawned, so
      -- the honest default for one whose outcome nobody has written is "we do
      -- not know yet". Defaulting to 'ok' meant any insert that omitted the
      -- column would be counted as a success by routing without an agent ever
      -- having answered. run() has always passed this explicitly, so the old
      -- default never actually minted one — this closes it before it does.
      -- 'asking' is not a failure. It is a worker that reached a decision it
      -- was told not to make on its own, stopped, and asked. Routing must not
      -- read it as either success or failure: nothing has been judged yet, and
      -- the run is still live in the sense that matters — its vendor session is
      -- sitting there holding everything it has read, waiting for a ruling.
      status        TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','ok','failed','stale','asking','stopped')),
      error         TEXT,
      pid           INTEGER,
      session_id    TEXT,
      retry_of      INTEGER,
      launch_cwd    TEXT,
      launch_seed   TEXT,
      launch_key    TEXT,
      launch_base   TEXT,
      no_failover   INTEGER NOT NULL DEFAULT 0,
      automatic_failover INTEGER NOT NULL DEFAULT 0,
      route_reason  TEXT,
      -- host or srt; null on rows created before sandbox selection existed
      sandbox       TEXT CHECK (sandbox IN ('host','srt')),
      branch        TEXT,
      branch_kept   TEXT,
      branch_kept_tip TEXT,
      worktree      TEXT,
      worktree_source TEXT CHECK (worktree_source IN ('recipe','git','readonly_recipe')),
      vendor_session TEXT,
      base_commit   TEXT,
      carry_happened INTEGER,
      carry_base_commit TEXT,
      carry_tracked_paths TEXT,
      carry_untracked_paths TEXT,
      parent_run_id INTEGER REFERENCES run(id),
      turn          INTEGER NOT NULL DEFAULT 1,
      files_changed INTEGER,
      changed_paths TEXT,
      lines_added   INTEGER,
      lines_removed INTEGER,
      tests_ran     INTEGER,
      tests_passed  INTEGER,
      deviations    INTEGER,
      escalations   INTEGER,
      stack         TEXT,
      model         TEXT,
      run_token     TEXT,
      evidence_excluded TEXT,
      outside_worktree_writes TEXT,
      input_tree    TEXT,
      head_commit   TEXT,
      review_ref    TEXT,
      agent_pid     INTEGER,
      mcp           INTEGER,
      mcp_server    TEXT,
      mcp_connected INTEGER,
      mcp_error     TEXT,
      mcp_trust_granted INTEGER,
      mcp_trust_path TEXT,
      schema_path   TEXT,
      docs_injected INTEGER,
      doc_revisions TEXT,
      canon_sha     TEXT,
      -- Driver seam. NULL on rows that predate the ACP pilot. Inherited by
      -- answer, continue, retry and failover so ORCH_TRANSPORT is only the
      -- initial default.
      transport     TEXT CHECK (transport IN ('cli','acp'))
    );
--> statement-breakpoint
CREATE TABLE run_message (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      direction      TEXT NOT NULL CHECK (direction IN ('to_worker','from_worker')),
      root_run_id     INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      run_id          INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      sender_session  TEXT,
      body            TEXT NOT NULL CHECK (length(trim(body)) > 0),
      created_at      TEXT NOT NULL,
      read_at         TEXT,
      read_by         TEXT,
      delivery        TEXT NOT NULL CHECK (delivery IN ('architect_cli','worker_tool'))
    );
--> statement-breakpoint
CREATE TABLE run_mutation_audit (
      run_id       INTEGER NOT NULL REFERENCES run(id),
      root_id      INTEGER NOT NULL REFERENCES run(id),
      action       TEXT NOT NULL CHECK (action IN ('adopt','answer','tell','stop','abandon','discard','sweep','reap','void','score','rescore','retry','continue','reclassify','canon-eval')),
      actor_session TEXT CHECK (actor_session IS NULL OR length(actor_session) > 0),
      at           TEXT NOT NULL,
      reason       TEXT
    );
--> statement-breakpoint
CREATE TABLE schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE score (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      delivery  TEXT NOT NULL CHECK (delivery IN ('none','partial','full')),
      -- Null exactly when delivery is 'none': there was nothing to judge.
      quality   TEXT CHECK (quality IN ('wrong','mixed','right')),
      -- DID IT BUILD WHAT IT WAS ASKED TO BUILD?
      --
      -- The third axis, and it exists because the first two cannot see the
      -- defining failure of a worker under an architect. An agent can return a
      -- complete change set (delivery: full) of correct, working, tested code
      -- (quality: right) that solves a DIFFERENT PROBLEM from the one specified
      -- — because it read an ambiguity, resolved it silently, and built on its
      -- own answer. Every existing cell scores that as a perfect run.
      --
      -- Null for every read-only job, which keeps the two-axis vocabulary
      -- exactly as it was: a review lens has no spec to be faithful to, and
      -- asking for a third verdict there would be friction with no payoff.
      fidelity  TEXT CHECK (fidelity IS NULL OR fidelity IN ('drifted','partial','faithful')),
      note      TEXT,
      scored_at TEXT NOT NULL,
      scored_by TEXT NOT NULL DEFAULT 'claude',
      -- A table constraint, so it must follow every column. It is what makes
      -- "nothing came back" and "came back wrong" different rows rather than a
      -- convention someone has to remember.
      CHECK ((delivery = 'none') = (quality IS NULL))
    );
--> statement-breakpoint
CREATE TABLE session_seen (
      session_id TEXT PRIMARY KEY,
      last_seen  TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE spawn (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      at            TEXT NOT NULL,
      session_id    TEXT,
      cwd           TEXT,
      event         TEXT,
      subagent_type TEXT,
      description   TEXT,
      prompt_bytes  INTEGER,
      decision      TEXT NOT NULL,
      why           TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE workflow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE workflow_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
      version_n INTEGER NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('set','fork','import','promote','retire')),
      author TEXT NOT NULL CHECK (length(trim(author)) > 0),
      reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      session_id TEXT,
      at TEXT NOT NULL,
      FOREIGN KEY(workflow_id, version_n) REFERENCES workflow_version(workflow_id, n)
    );
--> statement-breakpoint
CREATE TABLE workflow_version (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
      n INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','production','retired')),
      definition TEXT NOT NULL,
      author TEXT NOT NULL CHECK (length(trim(author)) > 0),
      reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      created_at TEXT NOT NULL,
      promoted_at TEXT,
      retired_at TEXT,
      UNIQUE(workflow_id, n)
    );
--> statement-breakpoint
CREATE INDEX blocker_kind ON blocker(kind, at);
--> statement-breakpoint
CREATE INDEX blocker_run ON blocker(run_id);
--> statement-breakpoint
CREATE UNIQUE INDEX canon_pack_address ON canon_pack(job, COALESCE(project, ''));
--> statement-breakpoint
CREATE UNIQUE INDEX doc_address ON doc(scope, COALESCE(subject, ''), slug);
--> statement-breakpoint
CREATE INDEX doc_revision_address ON doc_revision(scope, subject, slug, id);
--> statement-breakpoint
CREATE INDEX doc_revision_doc ON doc_revision(doc_id, id);
--> statement-breakpoint
CREATE INDEX doc_scope_subject ON doc(scope, subject);
--> statement-breakpoint
CREATE INDEX duel_job ON duel(job);
--> statement-breakpoint
CREATE INDEX monitor_condition_kind
      ON monitor_condition(kind, invocation_id);
--> statement-breakpoint
CREATE INDEX port_pair_target ON port_pair(target_project_id);
--> statement-breakpoint
CREATE INDEX port_ref_source_task ON port_ref_source(task_key);
--> statement-breakpoint
CREATE INDEX port_ref_target ON port_ref(target_project_id);
--> statement-breakpoint
CREATE INDEX port_skip_pair ON port_skip(pair_id);
--> statement-breakpoint
CREATE INDEX question_open ON question(answered_at) WHERE answered_at IS NULL;
--> statement-breakpoint
CREATE INDEX question_run ON question(run_id);
--> statement-breakpoint
CREATE INDEX review_calibration ON review_lens(lens, agent, model, review_id);
--> statement-breakpoint
CREATE INDEX run_job_agent ON run(job, agent);
--> statement-breakpoint
CREATE INDEX run_message_root ON run_message(root_run_id, id);
--> statement-breakpoint
CREATE INDEX run_message_unread
      ON run_message(root_run_id, direction, read_at) WHERE read_at IS NULL;
--> statement-breakpoint
CREATE INDEX run_mutation_audit_root
      ON run_mutation_audit(root_id);
--> statement-breakpoint
CREATE UNIQUE INDEX score_one_per_run ON score(run_id);
--> statement-breakpoint
CREATE INDEX score_run ON score(run_id);
--> statement-breakpoint
CREATE INDEX spawn_at ON spawn(at);
--> statement-breakpoint
CREATE INDEX workflow_event_version ON workflow_event(workflow_id, version_n, id);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_one_production
      ON workflow_version(workflow_id) WHERE status = 'production';
--> statement-breakpoint
CREATE INDEX workflow_version_workflow ON workflow_version(workflow_id, n);

--> statement-breakpoint
INSERT INTO schema_meta (key,value) VALUES ('schema','e5d0fa17fb7fb3087e4fda38a8cb31be0793fb4b68849ef1ae6eb08a127a9292');
