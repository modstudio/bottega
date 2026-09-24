// concern: database
/** Knows store location, connection authority, schema lifecycle, transactions, and fixture seeding. Must not know worktrees, runs, routing, reviews, contracts, transports, CLI adapters, or Docker resources. */
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { contentionTableExists, insertContention } from './contention.ts'
import {
  DATABASE_RESOLUTION,
  DB_PATH,
  legacyDatabaseRefusal,
  missingDatabaseMessage,
  unauthorizedDatabaseInitializationMessage,
} from './database-location.ts'
import {
  applyMigrations,
  migrationRefusal,
  readUserVersion,
  staleWriteRefusal,
} from './migrations.ts'

export { DATABASE_RESOLUTION, DB_PATH, ROOT } from './database-location.ts'

let handle: Database | null = null
let connectionWritable: boolean | null = null
let openedUserVersion: number | null = null
let schemaReload: ((from: number, to: number) => void) | null = null
type OpenHook = (database: Database) => void
export type OpenHooks = {
  afterWritableOpen?: OpenHook[]
  afterInitialize?: OpenHook[]
}
let openHooks: OpenHooks | null = null
export function registerOpenHooks(hooks: OpenHooks): () => void {
  const previous = openHooks
  openHooks = hooks
  return () => {
    openHooks = previous
  }
}
function registeredOpenHooks(): OpenHooks {
  if (openHooks && Object.values(openHooks).some((hooks) => hooks?.length)) return openHooks
  throw new Error(
    'refusing writable database open: standard store hooks are not registered\n' +
      'invariant: Writable stores run evidence hygiene, liveness reaping, and workflow seeding.\n' +
      'cleared by: call registerStandardHooks() before opening the store',
  )
}
function requireOpenHooksForWritableMode(): void {
  if (!linkedWorktreeReadOnly) registeredOpenHooks()
}
function runOpenHooks(moment: keyof OpenHooks, database: Database): void {
  for (const hook of registeredOpenHooks()[moment] ?? []) hook(database)
}
const LINKED_WORKTREE_WRITE_REFUSAL =
  'refusing to write run or project rows to the registered main store from a linked worktree\n' +
  'invariant: A linked-worktree binary cannot write lifecycle rows to the registered main store.\n' +
  'cleared by: orch <command> with ORCH_DB_WRITE=1, or set ORCH_DB to a scratch copy'
const LINKED_WORKTREE_SCHEMA_REFUSAL =
  'refusing to migrate the store from a linked-worktree binary; run it from the main checkout\n' +
  "invariant: Only the main checkout's binary migrates the store.\n" +
  'cleared by: orch migrate'

/**
 * Two paths name one file when their real paths agree. The file may not exist
 * yet, so the directory is what gets resolved and the name is appended: a
 * parent-directory alias or /tmp against /private/tmp then agrees before the
 * file is created, which is what "whatever names the path" requires.
 */
function sameStore(a: string, b: string): boolean {
  const real = (path: string) => {
    const dir = dirname(path)
    try {
      return join(realpathSync(dir), basename(path))
    } catch {
      return resolve(path)
    }
  }
  return real(a) === real(b)
}

/**
 * ORCH_DB used to authorize a linked-worktree binary to write whatever it named,
 * and the dispatcher exports the live path to every worker. A worker's own test
 * leg therefore held a write handle on the live store from a tree whose binary
 * should only ever have read it. Location and write authority are separate:
 * a linked binary may read the main store under any name and never writes it.
 * ORCH_DB_WRITE=1 is the operator's explicit, recorded insistence.
 */
export const linkedWorktreeReadOnly =
  DATABASE_RESOLUTION.linkedWorktreeBinary &&
  process.env.ORCH_DB_WRITE !== '1' &&
  (DATABASE_RESOLUTION.method !== 'ORCH_DB' ||
    sameStore(DB_PATH, DATABASE_RESOLUTION.mainStorePath))

let registeredStoreWriteProtected = false

export function databaseOpenMode(): 'read-write' | 'read-only linked worktree' {
  return linkedWorktreeReadOnly ? 'read-only linked worktree' : 'read-write'
}

/** Request the process connection for a mutation. */
export function writableDb(): Database {
  return db(true)
}

/** Already-open writable handle, or null. Does not open a connection. */
function openWritableHandle(): Database | null {
  if (
    !handle ||
    linkedWorktreeReadOnly ||
    registeredStoreWriteProtected ||
    connectionWritable !== true
  ) {
    return null
  }
  return handle
}

/**
 * Ask SQLite whether this connection can commit a write. The answer is
 * process-wide because db() has one process-wide connection, and a failed
 * probe must not turn every read into another attempted write.
 */
function databaseWritable(d: Database): boolean {
  if (connectionWritable !== null) return connectionWritable
  const probe = `__orch_write_probe_${process.pid}`
  try {
    // Committing the create matters: on WAL databases SQLite can prepare a
    // write transaction against a chmod-444 main file and fail only at commit.
    d.exec(`CREATE TABLE "${probe}" (value INTEGER); DROP TABLE "${probe}";`)
    connectionWritable = true
  } catch {
    connectionWritable = false
  }
  return connectionWritable
}

/**
 * Fixture-only: drop the process handle so the next db() opens whatever store
 * ORCH_DB names afresh. The test preload mints a new store per test and never
 * clears one, which needs the cached handle released between tests.
 */
export function closeDatabaseForFixture(): void {
  handle?.close()
  handle = null
  connectionWritable = null
  openedUserVersion = null
  schemaReload = null
}

/** Long-lived processes (orch mcp) reload instead of refusing a write after a migrate. */
export function enableSchemaReload(onReload: (from: number, to: number) => void): void {
  schemaReload = onReload
}

function refuseOrReloadStaleSchema(d: Database, forWrite: boolean): Database {
  if (handle && d !== handle) return d
  const actual = readUserVersion(d)
  const opened = openedUserVersion
  if (opened === null || actual === opened) return d
  if (schemaReload) {
    const from = opened
    handle?.close()
    handle = null
    connectionWritable = null
    openedUserVersion = null
    schemaReload(from, actual)
    return db(forWrite)
  }
  if (!forWrite) return d
  throw new Error(staleWriteRefusal(actual, opened, 'restart this process after orch migrate'))
}

export function db(writable = false): Database {
  if (writable && linkedWorktreeReadOnly) throw new Error(LINKED_WORKTREE_WRITE_REFUSAL)
  if (handle) {
    if (writable && registeredStoreWriteProtected) throw new Error(LINKED_WORKTREE_WRITE_REFUSAL)
    return refuseOrReloadStaleSchema(handle, writable)
  }
  const legacyRefusal = legacyDatabaseRefusal()
  if (legacyRefusal) throw new Error(legacyRefusal)
  if (!existsSync(DB_PATH)) throw new Error(missingDatabaseMessage())
  requireOpenHooksForWritableMode()
  const sidecarsExist = existsSync(`${DB_PATH}-wal`) || existsSync(`${DB_PATH}-shm`)
  const readOnlyPath =
    linkedWorktreeReadOnly && !sidecarsExist
      ? `${pathToFileURL(DB_PATH).href}?immutable=1`
      : DB_PATH
  const d = linkedWorktreeReadOnly
    ? new Database(readOnlyPath, { readonly: true })
    : new Database(DB_PATH, { readwrite: true, create: false })
  // Several `orch do` processes write concurrently during a fan-out. Without a
  // busy timeout SQLite fails the moment it finds the file locked rather than
  // waiting its turn, so a parallel launch loses most of its rows — the record
  // of the very runs it was launching.
  // wal_autocheckpoint defaults to 1000 pages, roughly 4MB. Nothing here writes
  // anywhere near that in a session, so the default never fires: the log was
  // measured at 1.4MB against an 80KB database, all of it uncheckpointed. A
  // lower threshold folds pages back in as they accumulate, and the size limit
  // lets the file shrink again once a checkpoint can restart it — `orch serve`
  // holds a connection open for hours, and a long-lived reader blocks
  // truncation but not the limit taking effect afterwards.
  d.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
  const refused = migrationRefusal(d)
  if (refused) {
    try {
      if (contentionTableExists(d) && !linkedWorktreeReadOnly) {
        writeTransaction(
          () =>
            insertContention(d, {
              resourceKind: 'store',
              resourceKey: DB_PATH,
              eventKind: 'refusal',
              cause: refused,
            }),
          d,
        )
      }
    } catch {
      /* still refuse; recording must not replace the refusal */
    }
    d.close()
    throw new Error(refused)
  }
  const registered = d.query('SELECT path FROM project WHERE name = ?').get(PLATFORM_SLUG) as {
    path: string
  } | null
  DATABASE_RESOLUTION.registeredPath = registered ? DATABASE_RESOLUTION.mainStorePath : null
  registeredStoreWriteProtected = Boolean(
    DATABASE_RESOLUTION.linkedWorktreeBinary &&
      DATABASE_RESOLUTION.registeredPath &&
      sameStore(DATABASE_RESOLUTION.registeredPath, DB_PATH) &&
      process.env.ORCH_DB_WRITE !== '1',
  )
  if (!linkedWorktreeReadOnly && !registeredStoreWriteProtected && databaseWritable(d)) {
    d.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 100;
      PRAGMA journal_size_limit = 1048576;
    `)
    seedProjects(d)
  }
  handle = d
  openedUserVersion = readUserVersion(d)
  if (connectionWritable) runOpenHooks('afterWritableOpen', d)
  if (writable && registeredStoreWriteProtected) throw new Error(LINKED_WORKTREE_WRITE_REFUSAL)
  return d
}

export function liveRuns(database: Database = db()): { worktree: string | null }[] {
  return database.query(`SELECT worktree FROM run WHERE status IN ('running','asking')`).all() as {
    worktree: string | null
  }[]
}

/** Open the only sanctioned multi-statement write transaction. */
export function writeTransaction<T>(fn: () => T, database: Database = db(true)): T {
  const conn = refuseOrReloadStaleSchema(database, true)
  return conn.transaction(fn).immediate()
}

/** Best-effort contention insert; never throws. busyTimeoutMs 0 uses a one-shot connection. */
export function tryWriteContention(
  row: import('./contention.ts').ContentionWrite,
  opts?: { busyTimeoutMs?: number },
): void {
  try {
    if (linkedWorktreeReadOnly || registeredStoreWriteProtected) return
    if (opts?.busyTimeoutMs === 0) {
      const d = new Database(DB_PATH, { readwrite: true, create: false })
      try {
        d.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON')
        // The one-shot connection sits outside writeTransaction's stale-schema
        // guard, so it checks the same invariant itself: a process writes only
        // the schema version it opened.
        const opened = openedUserVersion
        if (opened !== null && readUserVersion(d) !== opened) return
        if (!contentionTableExists(d)) return
        writeTransaction(() => insertContention(d, row), d)
      } finally {
        d.close()
      }
      return
    }
    const d = openWritableHandle()
    if (!d || !contentionTableExists(d)) return
    writeTransaction(() => insertContention(d, row), d)
  } catch {
    /* CONSTRAINTS: recording must not change lock, landing or detector behavior */
  }
}

/** The sole path that may create the orchestrator database. */
export function initializeDatabase(): string {
  if (DATABASE_RESOLUTION.linkedWorktreeBinary) throw new Error(LINKED_WORKTREE_SCHEMA_REFUSAL)
  if (existsSync(DB_PATH))
    throw new Error(`refusing to initialize: orchestrator database already exists: ${DB_PATH}`)
  const legacyRefusal = legacyDatabaseRefusal()
  if (legacyRefusal) throw new Error(legacyRefusal)
  if (!DATABASE_RESOLUTION.initializable) {
    throw new Error(unauthorizedDatabaseInitializationMessage())
  }
  registeredOpenHooks()
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const d = new Database(DB_PATH, { create: true })
  try {
    d.exec('PRAGMA foreign_keys = ON;')
    applyMigrations(d)
    seedProjects(d)
    runOpenHooks('afterInitialize', d)
  } finally {
    d.close()
  }
  return DB_PATH
}

/** Seed the project register once from paths already recorded in run history. */
function seedProjects(d: Database): void {
  const { n } = d.query('SELECT COUNT(*) AS n FROM project').get() as { n: number }
  if (n > 0) return
  const rows = d
    .query(
      `SELECT repo, cwd FROM run r
      WHERE repo IS NOT NULL AND cwd IS NOT NULL
        AND id = (SELECT MAX(id) FROM run x WHERE x.repo = r.repo AND x.cwd IS NOT NULL)`,
    )
    .all() as { repo: string; cwd: string }[]
  for (const { repo, cwd } of rows) {
    const parts = cwd.split('/')
    const at = parts.indexOf(repo)
    const path = at === -1 ? cwd : parts.slice(0, at + 1).join('/')
    try {
      d.query(
        `INSERT INTO project (name, path, stack, canon, settings) VALUES (?,?,?,1,'{}')
         ON CONFLICT(name) DO NOTHING`,
      ).run(repo, path, null)
    } catch {
      /* one malformed historical row does not block the remaining seed */
    }
  }
}

/** Main-checkout binary only: apply pending, ordered Drizzle migrations. */
export function migrateDatabase(): { path: string; versions: string[] } {
  if (DATABASE_RESOLUTION.linkedWorktreeBinary) throw new Error(LINKED_WORKTREE_SCHEMA_REFUSAL)
  const legacyRefusal = legacyDatabaseRefusal()
  if (legacyRefusal) throw new Error(legacyRefusal)
  if (!existsSync(DB_PATH)) throw new Error(missingDatabaseMessage())
  registeredOpenHooks()
  const d = new Database(DB_PATH, { readwrite: true, create: false })
  try {
    d.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
    const versions = applyMigrations(d)
    seedProjects(d)
    runOpenHooks('afterInitialize', d)
    return { path: DB_PATH, versions }
  } finally {
    d.close()
  }
}

/** One-time maintenance pass for roots whose original caller prompt remains on disk. */
export function backfillSpecSha(): { updated: number; missing: number } {
  if (DATABASE_RESOLUTION.linkedWorktreeBinary) throw new Error(LINKED_WORKTREE_SCHEMA_REFUSAL)
  const database = writableDb()
  const roots = database
    .query(
      `SELECT id, prompt_path FROM run
      WHERE parent_run_id IS NULL AND spec_sha IS NULL AND prompt_path IS NOT NULL`,
    )
    .all() as { id: number; prompt_path: string }[]
  let updated = 0
  let missing = 0
  writeTransaction(() => {
    for (const root of roots) {
      if (!existsSync(root.prompt_path)) {
        missing++
        continue
      }
      const prompt = readFileSync(root.prompt_path)
      const specSha = createHash('sha256').update(prompt).digest('hex').slice(0, 16)
      updated += database
        .query('UPDATE run SET spec_sha=? WHERE id=? AND spec_sha IS NULL')
        .run(specSha, root.id).changes
    }
  }, database)
  return { updated, missing }
}

export const nowIso = () => new Date().toISOString()

/**
 * Which Claude session made a call. Recorded so a session can be shown its own
 * unscored backlog: nobody else can judge whether an answer was useful, because
 * nobody else read it.
 *
 * CLAUDE_CODE_SESSION_ID is always set and identifies a session uniquely. The
 * other available identifiers do not do that job:
 *
 *   - CLAUDE_SESSION_ID does not exist. It never has; the fallback was dead.
 *   - CLAUDE_CODE_BRIDGE_SESSION_ID is set only while Remote Control is
 *     connected, and is SHARED between sessions on the same bridge. Preferring
 *     it recorded 26 of 66 runs with no session at all, and filed runs from a
 *     concurrent session onto this one's backlog — which is how a delegated
 *     agent came to be asked to score, and did score, work it had never read.
 *
 * The bridge id is still worth having for a claude.ai link, but it identifies a
 * connection, not a session, so it is never an identity. This returns the
 * primary id or null. A null owner is an unowned root; mutations that need an
 * identity to adopt refuse rather than proceeding under the shared bridge id.
 */
export const sessionId = (): string | null => process.env.CLAUDE_CODE_SESSION_ID ?? null

/**
 * A session seen inside this window is known live. A session outside it is
 * UNKNOWN, not dead: this row records orch activity, not the owning process.
 * Silence therefore never transfers its authority to another session.
 */
export const SESSION_LIVE_MS = 60 * 60 * 1000

/** Stamp once at the CLI boundary; heartbeat failure must never break a read. */
export function recordSessionSeen(sid: string | null = sessionId(), at = nowIso()): void {
  if (!sid) return
  const d = db()
  if (!connectionWritable) return
  try {
    d.query(
      `INSERT INTO session_seen (session_id, last_seen) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_seen = excluded.last_seen`,
    ).run(sid, at)
  } catch {
    // Liveness is a convenience signal. A failed stamp cannot break a command.
  }
}

/**
 * What "unscored" means, in one place.
 *
 * A run is owed a judgment only if it produced an answer somebody could read:
 * it succeeded, it is not a calibration probe, and nobody has judged it. A
 * failed run is not owed one — failing is already an implicit `delivery=none` —
 * and neither is a run still in flight.
 *
 * `orch doctor` and the dashboard card each subtracted a total score count from
 * a total run count instead, which counts probes, in-flight runs, failures and
 * abandoned rows as debt. They reported 28 unscored where `orch pending` — the
 * command that actually tells you what to do about it — reported none.
 */
/**
 * `parent_run_id IS NULL` is what keeps a conversation one thing to judge.
 *
 * A worker that asks two questions produces three rows, and only the first is
 * the unit of work — the other two are turns inside it. Asking for a verdict on
 * each would demand three judgments for one implementation, and would let an
 * agent reach the routing threshold by being inquisitive rather than by being
 * good. The root row carries the chain's outcome (see the roll-up in run.ts
 * and resolveRootFromLastTurn), so scoring the root scores the whole thing.
 */
