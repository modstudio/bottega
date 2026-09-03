import { Database } from 'bun:sqlite'

export type { Project } from './projects.ts'

const DB_PATH = process.env.HUB_DB ?? new URL('../hub.db', import.meta.url).pathname

let handle: Database | null = null

export function db(): Database {
  if (handle) return handle
  handle = new Database(DB_PATH, { create: true })
  handle.exec('PRAGMA journal_mode = WAL')
  // A collect run and a serving dashboard write and read the same file, and a
  // fan-out can put several collect legs in flight at once. Without this a
  // blocked writer fails instead of waiting — the orchestrator measured that
  // directly: 8 concurrent writers landed 40 of 160 rows before it had a
  // busy_timeout, and 160 of 160 after.
  handle.exec('PRAGMA busy_timeout = 15000')
  handle.exec('PRAGMA foreign_keys = ON')
  migrate(handle)
  return handle
}

export const nowIso = () => new Date().toISOString()

function migrate(d: Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS task (
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
    );

    CREATE INDEX IF NOT EXISTS task_project ON task(project, status_category);

    -- When a task changed state, which is NOT what a tracker's updated_at
    -- tells you. "Completed in the last 48 hours" is answerable only from a
    -- record of transitions, so the collector writes one every time it sees a
    -- status it did not see last pass.
    CREATE TABLE IF NOT EXISTS task_status_event (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key    TEXT NOT NULL REFERENCES task(key) ON DELETE CASCADE,
      at          TEXT NOT NULL,
      from_status TEXT,
      to_status   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS tse_at ON task_status_event(at);
    CREATE UNIQUE INDEX IF NOT EXISTS tse_one_per_change
      ON task_status_event(task_key, to_status, at);

    -- The heart of it: a half-open span during which SOMETHING was working.
    --
    -- Engaged time is the UNION of these per task, never their sum. Two agents
    -- running at once contribute the wall-clock they overlap on, once — which
    -- is the whole point: a session waiting on a delegated agent is not idle,
    -- and two delegated agents running together did not take twice as long.
    CREATE TABLE IF NOT EXISTS interval (
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
      open            INTEGER NOT NULL DEFAULT 0,
      CHECK (end_at >= start_at)
    );

    CREATE INDEX IF NOT EXISTS interval_task ON interval(task_key, start_at);
    CREATE INDEX IF NOT EXISTS interval_span ON interval(start_at, end_at);
    -- Re-collecting a window must not double up what it already recorded. A
    -- source+ref+start triple identifies one measurement.
    CREATE UNIQUE INDEX IF NOT EXISTS interval_once
      ON interval(source, ref, start_at);

    -- When a task key was committed, so a session working in a plain checkout
    -- can still be attributed. A worktree path names its task outright; a main
    -- checkout names nothing, and 41% of all recorded spans were landing in the
    -- untracked bucket for want of any other signal.
    CREATE TABLE IF NOT EXISTS commit_key (
      sha     TEXT PRIMARY KEY,
      repo    TEXT NOT NULL,
      task_key TEXT NOT NULL,
      at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS commit_key_when ON commit_key(repo, at);

    -- Day-grained totals, carried over from the orchestrator's metric table.
    -- The lenses need denominators that only exist per day (commits, lines,
    -- files), so this stays a separate grain rather than being derived.
    CREATE TABLE IF NOT EXISTS day (
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

    -- What the settings tab writes. Secrets never land here: SMTP passwords
    -- and MCP tokens stay in the Keychain and ~/.claude/.env, and the UI shows
    -- only whether each resolves.
    CREATE TABLE IF NOT EXISTS setting (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS send (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      window     TEXT NOT NULL,
      recipients TEXT NOT NULL,
      projects   TEXT NOT NULL,
      items      INTEGER NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('sent','skipped','failed')),
      error      TEXT,
      -- A test send is a real send to a different address. Marked rather than
      -- hidden, so the log shows what actually left the machine, and rather
      -- than left unmarked, so a test is never mistaken for the daily report
      -- having gone out.
      test       INTEGER NOT NULL DEFAULT 0
    );

    -- The local tracker's key counter. A table rather than max(key)+1 so a
    -- deleted task never hands its number to a new one.
    CREATE TABLE IF NOT EXISTS seq (
      name TEXT PRIMARY KEY,
      next INTEGER NOT NULL
    );
  `)

  // Added after task first shipped. Keep this additive: hub.db is live state,
  // and rebuilding task would put every interval and status event reference at
  // unnecessary risk.
  addColumn(d, 'task', 'parent_key', 'TEXT REFERENCES task(key) ON DELETE SET NULL')
  addColumn(d, 'task', 'body', 'TEXT')
  addColumn(d, 'task', 'assignee', 'TEXT')
  d.exec(`
    CREATE INDEX IF NOT EXISTS task_parent ON task(parent_key);

    CREATE TABLE IF NOT EXISTS task_comment (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key   TEXT NOT NULL REFERENCES task(key) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS task_comment_task ON task_comment(task_key, created_at);
  `)
}

/** Columns added after the first schema shipped; SQLite has no IF NOT EXISTS here. */
function addColumn(d: Database, table: string, col: string, decl: string) {
  const cols = d.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((candidate) => candidate.name === col)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
  }
}

/** Used only inside the task-import transaction, which supplies the write lock. */
export function nextImportedTaskKey(prefix: string): string {
  const d = db()
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`, 'i')
  const highest = d.query<{ key: string }, []>(`SELECT key FROM task`).all()
    .reduce((max, row) => {
      const match = pattern.exec(row.key)
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
  const name = `task:${prefix}`
  const sequence = d.query<{ next: number }, [string]>(`SELECT next FROM seq WHERE name = ?`).get(name)
  const number = Math.max(highest + 1, sequence?.next ?? 1)
  d.query(
    `INSERT INTO seq (name, next) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET next = excluded.next`,
  ).run(name, number + 1)
  return `${prefix.toUpperCase()}-${number}`
}
