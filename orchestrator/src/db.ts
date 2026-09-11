// concern: database
/** Knows store location, connection authority, schema lifecycle, transactions, and fixture seeding.
 * Must not know worktrees, runs, routing, reviews, contracts, transports, CLI adapters, or Docker resources. */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { DATABASE_RESOLUTION, DB_PATH, missingDatabaseMessage, registeredRepositoryMissingDatabase } from './database-location.ts'
import { applyMigrations, migrationRefusal, readUserVersion, staleWriteRefusal } from './migrations.ts'
import { contentionTableExists, insertContention } from './contention.ts'
import { REVIEW_COVERAGE, REVIEW_LIMITS, REVIEW_OVERLAP, REVIEW_REPRODUCED } from './review-vocabulary.ts'
export { label } from './outcome.ts'
export { DATABASE_RESOLUTION, DB_PATH, ROOT } from './database-location.ts'

/** Open-time hooks retained until entrypoints register them in a later slice.
 * These are the only delayed upward dependencies owned by the database core. */
const excludeSharedOutputRuns: typeof import('./evidence-query.ts').excludeSharedOutputRuns = (...args) =>
  (require('./evidence-query.ts') as typeof import('./evidence-query.ts')).excludeSharedOutputRuns(...args)
const reapStale: typeof import('./run-liveness.ts').reapStale = (...args) =>
  (require('./run-liveness.ts') as typeof import('./run-liveness.ts')).reapStale(...args)

let handle: Database | null = null
let connectionWritable: boolean | null = null
let openedUserVersion: number | null = null
let schemaReload: ((from: number, to: number) => void) | null = null

export const LINKED_WORKTREE_WRITE_REFUSAL =
  'refusing to write run or project rows to the registered main store from a linked worktree\n' +
  'invariant: A linked-worktree binary cannot write lifecycle rows to the registered main store.\n' +
  'cleared by: orch <command> with ORCH_DB_WRITE=1, or set ORCH_DB to a scratch copy'

export const LINKED_WORKTREE_SCHEMA_REFUSAL =
  'refusing to migrate the store from a linked-worktree binary; run it from the main checkout\n' +
  'invariant: Only the main checkout\'s binary migrates the store.\n' +
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
    try { return join(realpathSync(dir), basename(path)) } catch { return resolve(path) }
  }
  return real(a) === real(b)
}

/**
 * ORCH_DB used to authorise a linked-worktree binary to write whatever it named,
 * and the dispatcher exports the live path to every worker. A worker's own test
 * leg therefore held a write handle on the live store from a tree whose binary
 * should only ever have read it (DEV-314's class, third instance 2026-09-07:
 * every row in 27 tables deleted). Location and write authority are separate:
 * a linked binary may read the main store under any name and never writes it.
 * ORCH_DB_WRITE=1 is the operator's explicit, recorded insistence.
 */
export const linkedWorktreeReadOnly =
  DATABASE_RESOLUTION.linkedWorktreeBinary
  && process.env.ORCH_DB_WRITE !== '1'
  && (DATABASE_RESOLUTION.method !== 'ORCH_DB'
    || (DATABASE_RESOLUTION.mainStorePath !== null && sameStore(DB_PATH, DATABASE_RESOLUTION.mainStorePath)))

let registeredStoreWriteProtected = false

export function databaseOpenMode(): 'read-write' | 'read-only linked worktree' {
  return linkedWorktreeReadOnly ? 'read-only linked worktree' : 'read-write'
}

/** Request the process connection for a mutation. */
export function writableDb(): Database {
  return db(true)
}

/** Already-open writable handle, or null. Does not open a connection. */
export function openWritableHandle(): Database | null {
  if (!handle || linkedWorktreeReadOnly || registeredStoreWriteProtected || connectionWritable !== true) {
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

export function openedSchemaVersion(): number | null {
  return openedUserVersion
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
  if (!existsSync(DB_PATH)) throw new Error(missingDatabaseMessage())
  const sidecarsExist = existsSync(`${DB_PATH}-wal`) || existsSync(`${DB_PATH}-shm`)
  const readOnlyPath = linkedWorktreeReadOnly && !sidecarsExist
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
        writeTransaction(() => insertContention(d, {
          resourceKind: 'store', resourceKey: DB_PATH, eventKind: 'refusal', cause: refused,
        }), d)
      }
    } catch { /* still refuse; recording must not replace the refusal */ }
    d.close()
    throw new Error(refused)
  }
  const registered = d.query('SELECT path FROM project WHERE name = ?').get(PLATFORM_SLUG) as
    { path: string } | null
  DATABASE_RESOLUTION.registeredPath = registered ? join(registered.path, 'orchestrator', 'orch.db') : null
  registeredStoreWriteProtected = Boolean(
    DATABASE_RESOLUTION.linkedWorktreeBinary &&
    DATABASE_RESOLUTION.registeredPath &&
    sameStore(DATABASE_RESOLUTION.registeredPath, DB_PATH) &&
    process.env.ORCH_DB_WRITE !== '1'
  )
  const registeredMissing = registered
    ? registeredRepositoryMissingDatabase(DATABASE_RESOLUTION, registered.path)
    : null
  if (registeredMissing) {
    d.close()
    throw new Error(missingDatabaseMessage(registeredMissing))
  }
  if (!linkedWorktreeReadOnly && !registeredStoreWriteProtected && databaseWritable(d)) {
    d.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 100;
      PRAGMA journal_size_limit = 1048576;
    `)
    excludeSharedOutputRuns(d)
    seedProjects(d)
  }
  handle = d
  openedUserVersion = readUserVersion(d)
  if (connectionWritable) reapStale(d)
  if (writable && registeredStoreWriteProtected) throw new Error(LINKED_WORKTREE_WRITE_REFUSAL)
  return d
}

export function liveRuns(database: Database = db()): { worktree: string | null }[] {
  return database.query(
    `SELECT worktree FROM run WHERE status IN ('running','asking')`,
  ).all() as { worktree: string | null }[]
}

export function liveRunCount(database: Database = db()): number {
  return liveRuns(database).length
}

/** Open the only sanctioned multi-statement write transaction. */
export function writeTransaction<T>(fn: () => T, database: Database = db(true)): T {
  const conn = refuseOrReloadStaleSchema(database, true)
  return conn.transaction(fn).immediate()
}

/** Best-effort contention insert; never throws. busyTimeoutMs 0 uses a one-shot connection. */
export function tryWriteContention(
  row: import('./contention.ts').ContentionWrite, opts?: { busyTimeoutMs?: number },
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
        insertContention(d, row)
      } finally { d.close() }
      return
    }
    const d = openWritableHandle()
    if (!d || !contentionTableExists(d)) return
    writeTransaction(() => insertContention(d, row), d)
  } catch { /* CONSTRAINTS: recording must not change lock, landing or detector behaviour */ }
}

/** The sole path that may create the orchestrator database. */
export function initializeDatabase(): string {
  if (DATABASE_RESOLUTION.linkedWorktreeBinary) throw new Error(LINKED_WORKTREE_SCHEMA_REFUSAL)
  if (existsSync(DB_PATH)) throw new Error(`refusing to initialize: orchestrator database already exists: ${DB_PATH}`)
  if (!DATABASE_RESOLUTION.initializable) {
    throw new Error(`refusing to initialize from a worktree binary: ${DB_PATH}\nrun orch init-db from the main checkout`)
  }
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const d = new Database(DB_PATH, { create: true })
  try {
    d.exec('PRAGMA foreign_keys = ON;')
    applyMigrations(d)
    excludeSharedOutputRuns(d)
    seedProjects(d)
    seedWorkflows(d)
  } finally {
    d.close()
  }
  return DB_PATH
}

/** Fixture-only: build scratch stores through the same migration journal as production. */
export function applySchemaForFixture(d: Database): void {
  applyMigrations(d)
  seedWorkflows(d)
}
export const applySchema = applySchemaForFixture

/** Seed the project register once from paths already recorded in run history. */
function seedProjects(d: Database): void {
  const { n } = d.query('SELECT COUNT(*) AS n FROM project').get() as { n: number }
  if (n > 0) return
  const rows = d.query(
    `SELECT repo, cwd FROM run r
      WHERE repo IS NOT NULL AND cwd IS NOT NULL
        AND id = (SELECT MAX(id) FROM run x WHERE x.repo = r.repo AND x.cwd IS NOT NULL)`,
  ).all() as { repo: string; cwd: string }[]
  for (const { repo, cwd } of rows) {
    const parts = cwd.split('/')
    const at = parts.indexOf(repo)
    const path = at === -1 ? cwd : parts.slice(0, at + 1).join('/')
    try {
      d.query(
        `INSERT INTO project (name, path, stack, canon, settings) VALUES (?,?,?,1,'{}')
         ON CONFLICT(name) DO NOTHING`,
      ).run(repo, path, null)
    } catch { /* one malformed historical row does not block the remaining seed */ }
  }
}

/** Fixture-only: create or open a scratch store through the migrator. */
export function bootstrapFixtureStore(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  const d = new Database(path, { create: true })
  try {
    d.exec('PRAGMA foreign_keys = ON;')
    applyMigrations(d)
    excludeSharedOutputRuns(d)
    seedProjects(d)
    seedWorkflows(d)
  } finally {
    d.close()
  }
  return path
}

/** Main-checkout binary only: apply pending, ordered Drizzle migrations. */
export function migrateDatabase(): { path: string; versions: string[] } {
  if (DATABASE_RESOLUTION.linkedWorktreeBinary) throw new Error(LINKED_WORKTREE_SCHEMA_REFUSAL)
  if (!existsSync(DB_PATH)) throw new Error(missingDatabaseMessage())
  const d = new Database(DB_PATH, { readwrite: true, create: false })
  try {
    d.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
    const versions = applyMigrations(d)
    excludeSharedOutputRuns(d)
    seedProjects(d)
    seedWorkflows(d)
    return { path: DB_PATH, versions }
  } finally {
    d.close()
  }
}

/** One-time maintenance pass for roots whose original caller prompt remains on disk. */
export function backfillSpecSha(): { updated: number; missing: number } {
  if (DATABASE_RESOLUTION.linkedWorktreeBinary) throw new Error(LINKED_WORKTREE_SCHEMA_REFUSAL)
  const database = writableDb()
  const roots = database.query(
    `SELECT id, prompt_path FROM run
      WHERE parent_run_id IS NULL AND spec_sha IS NULL AND prompt_path IS NOT NULL`,
  ).all() as { id: number; prompt_path: string }[]
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
      updated += database.query(
        'UPDATE run SET spec_sha=? WHERE id=? AND spec_sha IS NULL',
      ).run(specSha, root.id).changes
    }
  }, database)
  return { updated, missing }
}

const seedDefinition = (definition: unknown) => JSON.stringify(definition)

function seedWorkflows(d: Database): void {
  const seeds = [
    {
      slug: 'ship',
      definition: {
        title: 'Ship a task', description: 'Rebase, independently review, triage, fix, land, and close a task.',
        arguments: [
          { name: 'key', required: true, description: 'The task key.' },
          { name: 'branch', required: true, description: 'The branch ref to land.' },
          { name: 'worktree', required: true, description: "The branch's worktree path." },
        ],
        modes: [{ slug: 'default', title: 'Ship', default: true,
          steps: ['rebase','lens','score','triage','complete','fix','land','close'] }],
        steps: [
          { slug: 'rebase', title: 'Rebase and verify', job: null, autonomy: 'auto', gate: 'bun run check', body: 'In `{{worktree}}`, run `git rebase main`, then run `bun run check`.' },
          { slug: 'lens', title: 'Run independent review lenses', job: 'review-lens', autonomy: 'auto', gate: null, body: "Use `/absolute/path/to/main-checkout/bin/orch` from the main checkout, never a worktree's ./bin/orch, which writes to an empty per-worktree orch.db. Dispatch each named lens against the branch worktree. Always run correctness. Also run migration-safety when the change touches orchestrator/src/db.ts. Also run craft when the change adds a new module.\n\n`/absolute/path/to/main-checkout/bin/orch do review-lens --cwd {{worktree}} --carry --key {{key}} --lens correctness`\n\nRepeat with --lens migration-safety and --lens craft when those apply." },
          { slug: 'score', title: 'Score the lenses', job: null, autonomy: 'auto', gate: null, body: `Read every lens result and run \`orch score <run-id> <delivery> <quality> --reproduced <${REVIEW_REPRODUCED.join('|')}> --coverage <${REVIEW_COVERAGE.join('|')}> --limits <${REVIEW_LIMITS.join('|')}> --overlap <${REVIEW_OVERLAP.join('|')}> --note "..."\` honestly for each. Grading records the lens on the review; there is no separate record step.` },
          { slug: 'triage', title: 'Triage every finding', job: null, autonomy: 'ask', gate: null, body: 'The architect must mark every finding accepted, modified, rejected, or skipped with `orch review triage <review-id> <finding> <disposition>`.' },
          { slug: 'complete', title: 'Complete the review', job: null, autonomy: 'auto', gate: null, body: 'After every finding is triaged, run `orch review complete <review-id>`.' },
          { slug: 'fix', title: 'Fix accepted findings', job: 'implement', autonomy: 'ask', gate: null, body: 'Only if findings were accepted or modified, run `orch continue <original-run-id> "Fix the accepted review findings."`. Then loop back to `lens`, because the tree changed.' },
          { slug: 'land', title: 'Land the branch', job: null, autonomy: 'ask', gate: null, body: 'Notify the other session first, then run `orch land {{branch}}`.' },
          { slug: 'close', title: 'Close the task', job: null, autonomy: 'auto', gate: null, body: 'Run `hub task comment {{key}} "Shipped."`, then `hub task close {{key}}`. Do not push; `orch land` never pushes, and pushing origin is a separate deliberate act.' },
        ],
      },
    },
    {
      slug: 'filed-issue',
      definition: {
        title: 'Resolve a filed issue', description: "A projection of issue.ts's coordinator for inspection.",
        arguments: [{ name: 'key', required: true, description: 'The filed task key.' }],
        modes: [{ slug: 'default', title: 'Resolve', default: true,
          steps: ['diagnose','fix','verify','blast-radius','triage','land'] }],
        steps: [
          { slug: 'diagnose', title: 'Diagnose', job: 'diagnose', autonomy: 'auto', gate: null, body: 'Dispatch `orch do diagnose --key {{key}}` and establish the cause before editing.' },
          { slug: 'fix', title: 'Fix', job: 'issue-worker', autonomy: 'auto', gate: null, body: 'Dispatch `orch do issue-worker --key {{key}}` with the diagnosis.' },
          { slug: 'verify', title: 'Verify', job: null, autonomy: 'auto', gate: 'bun run check', body: 'Reproduce the original condition before and after the fix, then run the registered project gate.' },
          { slug: 'blast-radius', title: 'Review blast radius', job: 'review-lens', autonomy: 'auto', gate: null, body: "Use `/absolute/path/to/main-checkout/bin/orch` from the main checkout, never a worktree's ./bin/orch, which writes to an empty per-worktree orch.db. Run `/absolute/path/to/main-checkout/bin/orch do review-lens --carry --key {{key}} --lens issue-blast-radius` from the fix worktree." },
          { slug: 'triage', title: 'Triage findings', job: null, autonomy: 'ask', gate: null, body: 'The architect triages every recorded finding before the issue can land.' },
          { slug: 'land', title: 'Land', job: null, autonomy: 'ask', gate: null, body: 'Run the mechanical `orch land <branch>` gate only after verification and review are complete.' },
        ],
      },
    },
  ]
  const now = nowIso()
  writeTransaction(() => {
    for (const seed of seeds) {
      if (d.query('SELECT id FROM workflow WHERE slug=?').get(seed.slug)) continue
      const workflow = d.query('INSERT INTO workflow (slug, created_at) VALUES (?, ?) RETURNING id')
        .get(seed.slug, now) as { id: number }
      d.query(`INSERT INTO workflow_version
        (workflow_id,n,status,definition,author,reason,created_at,promoted_at)
        VALUES (?,1,'production',?,'seed','DEV-257 seed',?,?)`)
        .run(workflow.id, seedDefinition(seed.definition), now, now)
      d.query(`INSERT INTO workflow_event
        (workflow_id,version_n,event,author,reason,session_id,at)
        VALUES (?,1,'set','seed','DEV-257 seed',NULL,?)`).run(workflow.id, now)
    }
  }, d)
}

export const nowIso = () => new Date().toISOString()

/**
 * Which Claude session made a call. Recorded so a session can be shown its own
 * unscored backlog: nobody else can judge whether an answer was useful, because
 * nobody else read it.
 *
 * CLAUDE_CODE_SESSION_ID is the one that is always set, and is the one that
 * identifies a session uniquely. The two that used to be read here do not do
 * that job:
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
export const sessionId = (): string | null =>
  process.env.CLAUDE_CODE_SESSION_ID ?? null

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
 * A run is owed a judgement only if it produced an answer somebody could read:
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
 * each would demand three judgements for one implementation, and would let an
 * agent reach the routing threshold by being inquisitive rather than by being
 * good. The root row carries the chain's outcome (see the roll-up in run.ts
 * and resolveRootFromLastTurn), so scoring the root scores the whole thing.
 */
