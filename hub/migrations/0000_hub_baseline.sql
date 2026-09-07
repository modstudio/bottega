-- Hand-written baseline from trunk's canonical sqlite_master DDL, verbatim.
-- SQLite schema generators do not preserve every table constraint and partial
-- index, so future migrations for this store are hand-written SQL.
CREATE TABLE commit_key (
      sha     TEXT PRIMARY KEY,
      repo    TEXT NOT NULL,
      task_key TEXT NOT NULL,
      at      TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE day (
      day             TEXT PRIMARY KEY,
      claude_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_read      INTEGER NOT NULL DEFAULT 0,
      messages        INTEGER NOT NULL DEFAULT 0,
      tasks           INTEGER NOT NULL DEFAULT 0,
      canon_tokens    INTEGER NOT NULL DEFAULT 0,
      other_tokens    INTEGER NOT NULL DEFAULT 0,
      commits         INTEGER NOT NULL DEFAULT 0,
      files           INTEGER NOT NULL DEFAULT 0,
      lines_product   INTEGER NOT NULL DEFAULT 0,
      lines_test      INTEGER NOT NULL DEFAULT 0,
      lines_docs      INTEGER NOT NULL DEFAULT 0,
      lines_config    INTEGER NOT NULL DEFAULT 0,
      lines_generated INTEGER NOT NULL DEFAULT 0,
      collected_at    TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE interval (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      -- NULL where nothing named a task. Reported as an explicit unattributed
      -- row per project rather than dropped: work carrying no ticket is the
      -- blind spot every denominator here shares, so hiding it would flatter
      -- every number on the page.
      task_key        TEXT,
      project         TEXT,
      source          TEXT NOT NULL CHECK (source IN ('claude','codex','orch')),
      agent           TEXT,
      -- The job type an agent was given. Without it a nested run reads as
      -- "grok, 5m, done", which says who and how long but not what.
      job             TEXT,
      start_at        TEXT NOT NULL,
      end_at          TEXT NOT NULL,
      claude_tokens   INTEGER NOT NULL DEFAULT 0,
      vendor_tokens   INTEGER NOT NULL DEFAULT 0,
      vendor_cost_usd REAL,
      -- Session id or orch run id, so an implausible figure can be traced back
      -- to the thing that produced it instead of being taken on faith.
      ref             TEXT NOT NULL,
      -- How the task key was decided, so a wrong attribution is diagnosable
      -- rather than merely wrong.
      via             TEXT,
      -- Still going. An open span's end_at is only the moment the collector
      -- last looked, so it must NOT be read as when the work stopped: doing so
      -- made every live run read as finished one second after a collect, and
      -- the "agents working now" count sat at zero through a seven-way fan-out.
      -- Queries extend an open span to now instead.
      open            INTEGER NOT NULL DEFAULT 0, session_id TEXT,
      CHECK (end_at >= start_at)
    );
--> statement-breakpoint
CREATE TABLE question (
      question_id INTEGER PRIMARY KEY,
      run_ref     TEXT NOT NULL,
      root_ref    TEXT NOT NULL,
      task_key    TEXT,
      session_id  TEXT,
      asked_at    TEXT NOT NULL,
      answered_at TEXT
    );
--> statement-breakpoint
CREATE TABLE send (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      window     TEXT NOT NULL,
      recipients TEXT NOT NULL,
      projects   TEXT NOT NULL,
      items      INTEGER NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('sent','skipped','failed')),
      error      TEXT
    , test INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE seq (
      name TEXT PRIMARY KEY,
      next INTEGER NOT NULL
    );
--> statement-breakpoint
CREATE TABLE setting (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE task (
      key             TEXT PRIMARY KEY,
      project         TEXT NOT NULL,
      title           TEXT,
      status          TEXT,
      -- The trackers each have their own status vocabulary; this is the
      -- normalised one the dashboard groups on.
      status_category TEXT CHECK (status_category IN ('open','active','review','done','dropped')),
      opened_at       TEXT,
      closed_at       TEXT,
      updated_at      TEXT,
      -- Where the row came from. 'git' means it was inferred from commit
      -- subjects because no tracker was reachable, and carries no title or
      -- status — the dashboard says so rather than showing a blank as fact.
      source          TEXT NOT NULL CHECK (source IN ('mcp','git','local')),
      first_seen      TEXT NOT NULL,
      last_seen       TEXT NOT NULL
    , parent_key TEXT REFERENCES task(key) ON DELETE SET NULL, body TEXT, assignee TEXT);
--> statement-breakpoint
CREATE TABLE task_comment (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key   TEXT NOT NULL REFERENCES task(key) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE task_document (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key   TEXT NOT NULL REFERENCES task(key) ON DELETE CASCADE,
      role       TEXT CHECK (role IN ('handoff')),
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      -- This is an optimistic-concurrency token, not retained history. A body
      -- replacement compares and writes it in one SQL statement so two
      -- sessions cannot both pass a check in application code and overwrite.
      version    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
--> statement-breakpoint
CREATE TABLE task_status_event (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key    TEXT NOT NULL REFERENCES task(key) ON DELETE CASCADE,
      at          TEXT NOT NULL,
      from_status TEXT,
      to_status   TEXT NOT NULL
    );
--> statement-breakpoint
CREATE INDEX commit_key_when ON commit_key(repo, at);
--> statement-breakpoint
CREATE UNIQUE INDEX interval_once
      ON interval(source, ref, start_at);
--> statement-breakpoint
CREATE INDEX interval_span ON interval(start_at, end_at);
--> statement-breakpoint
CREATE INDEX interval_task ON interval(task_key, start_at);
--> statement-breakpoint
CREATE INDEX question_open ON question(answered_at) WHERE answered_at IS NULL;
--> statement-breakpoint
CREATE INDEX question_root ON question(root_ref);
--> statement-breakpoint
CREATE INDEX task_comment_task ON task_comment(task_key, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX task_document_one_role
      ON task_document(task_key, role) WHERE role IS NOT NULL;
--> statement-breakpoint
CREATE INDEX task_document_task
      ON task_document(task_key, created_at, id);
--> statement-breakpoint
CREATE INDEX task_parent ON task(parent_key);
--> statement-breakpoint
CREATE INDEX task_project ON task(project, status_category);
--> statement-breakpoint
CREATE INDEX tse_at ON task_status_event(at);
--> statement-breakpoint
CREATE UNIQUE INDEX tse_one_per_change
      ON task_status_event(task_key, to_status, at);
