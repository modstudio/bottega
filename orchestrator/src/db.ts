import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  DATABASE_RESOLUTION, DB_PATH, missingDatabaseMessage, registeredRepositoryMissingDatabase,
} from './database-location.ts'
import { applyMigrations, migrationRefusal } from './migrations.ts'
export { label } from './outcome.ts'
export { DATABASE_RESOLUTION, DB_PATH, ROOT } from './database-location.ts'

/**
 * Architect-graded review evidence. Keep the closed vocabularies here: the
 * schema, CLI hints and refusals all import these values instead of copying
 * strings that can drift apart.
 */
export const REVIEW_REPRODUCED = ['none', 'some', 'all'] as const
export const REVIEW_COVERAGE = ['empty', 'partial', 'adequate'] as const
export const REVIEW_LIMITS = ['named', 'absent'] as const
export const REVIEW_OVERLAP = ['unique', 'shared', 'none', 'alone'] as const
export const REVIEW_SEVERITY = ['critical', 'high', 'medium', 'low'] as const
export const MONITOR_SEVERITY = ['informational', 'attention'] as const
export type ReviewReproduced = typeof REVIEW_REPRODUCED[number]
export type ReviewCoverage = typeof REVIEW_COVERAGE[number]
export type ReviewLimits = typeof REVIEW_LIMITS[number]
export type ReviewOverlap = typeof REVIEW_OVERLAP[number]
export type ReviewSeverity = typeof REVIEW_SEVERITY[number]
export type MonitorSeverity = typeof MONITOR_SEVERITY[number]

export const RUN_MUTATION_ACTIONS = [
  'adopt', 'answer', 'tell', 'stop', 'abandon', 'discard', 'sweep', 'reap', 'void', 'score', 'rescore',
  'retry', 'continue', 'reclassify', 'canon-eval',
] as const
export type RunMutationAction = typeof RUN_MUTATION_ACTIONS[number]
export type RootAuthority = {
  runId: number; rootId: number; owner: string | null; actor: string | null
}

let handle: Database | null = null
let connectionWritable: boolean | null = null

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
}

export function db(writable = false): Database {
  if (writable && linkedWorktreeReadOnly) throw new Error(LINKED_WORKTREE_WRITE_REFUSAL)
  if (handle) {
    if (writable && registeredStoreWriteProtected) throw new Error(LINKED_WORKTREE_WRITE_REFUSAL)
    return handle
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
export function writeTransaction<T>(fn: () => T, database: Database = db()): T {
  return database.transaction(fn).immediate()
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

function runMutationAuthority(database: Database, runId: number): RootAuthority {
  const row = database.query(
    `SELECT requested.id run_id, root.id root_id, root.session_id owner
       FROM run requested
       JOIN run root ON root.id = COALESCE(requested.parent_run_id, requested.id)
      WHERE requested.id = ?`,
  ).get(runId) as { run_id: number; root_id: number; owner: string | null } | null
  if (!row) throw new Error(`no run ${runId}`)
  return {
    runId: row.run_id, rootId: row.root_id, owner: row.owner, actor: sessionId(),
  }
}

export function runMutationActor(runId: number): RootAuthority {
  return runMutationAuthority(db(), runId)
}

export function authorizeRunMutation(
  runId: number,
  action: RunMutationAction | 'receipt',
): RootAuthority {
  writableDb()
  const authority = runMutationActor(runId)
  if (authority.owner && authority.actor !== authority.owner) {
    throw new Error(
      `run ${runId} is owned by session ${authority.owner}; ` +
      `current session ${authority.actor ?? 'no session identity is present'} cannot ${action} it`,
    )
  }
  return authority
}

export function auditRunMutation(
  authority: RootAuthority,
  action: RunMutationAction,
  reason: string | null = null,
  database: Database = db(),
): void {
  database.query(
    `INSERT INTO run_mutation_audit (run_id, root_id, action, actor_session, at, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(authority.runId, authority.rootId, action, authority.actor, nowIso(), reason)
}

const ADOPTING_ACTIONS = [
  'answer', 'tell', 'stop', 'abandon', 'discard', 'void', 'continue', 'score',
  'retry', 'receipt',
] as const
type AdoptingAction = typeof ADOPTING_ACTIONS[number]

/** Atomically claim an unowned chain before an authoritative mutation. */
export function adoptRunMutation(
  authority: RootAuthority,
  action: AdoptingAction,
  database: Database = db(),
): RootAuthority {
  if (authority.owner) return authority
  if (!authority.actor) {
    throw new Error(
      `run ${authority.runId} is unowned; CLAUDE_CODE_SESSION_ID is not set`,
    )
  }
  const claimed = database.query(
    'UPDATE run SET session_id=? WHERE id=? AND session_id IS NULL',
  ).run(authority.actor, authority.rootId)
  if (claimed.changes !== 1) {
    const owner = database.query('SELECT session_id FROM run WHERE id=?').get(authority.rootId) as
      { session_id: string | null } | null
    if (!owner?.session_id || owner.session_id !== authority.actor) {
      throw new Error(
        `run ${authority.runId} was adopted by session ${owner?.session_id ?? 'unknown'} ` +
        `before current session ${authority.actor} could ${action} it`,
      )
    }
    return { ...authority, owner: owner.session_id }
  }
  const adopted = { ...authority, owner: authority.actor }
  auditRunMutation(adopted, 'adopt', `before ${action}`, database)
  return adopted
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

/**
 * Why a collided output file cannot be routing evidence.
 *
 * The filename used to be `${Date.now()}-${agent}-${job}`, so runs that
 * started in the same millisecond with the same agent and job wrote one
 * file and the last to finish overwrote the rest. Commit 44f2db3 named
 * files after the run id; the damage that remains is historical. Within a
 * colliding group we cannot tell which run's output survived, so every
 * member is excluded rather than guessing a winner.
 */
export const SHARED_OUTPUT_REASON =
  'shared an output file with other runs; a clock-based name collision destroyed all but one, and we cannot tell which survived'

/**
 * Stamp every run whose output_path is shared with at least one other.
 *
 * Idempotent, and never overwrites a reason that is already there: a
 * person who excluded a run for a different reason keeps their words.
 * Returns how many rows this call actually wrote, so a backfill can be
 * counted rather than guessed.
 */
export function excludeSharedOutputRuns(d: Database = db()): number {
  const r = d.query(
    `UPDATE run SET evidence_excluded = ?
      WHERE evidence_excluded IS NULL
        AND output_path IN (
          SELECT output_path FROM run
           WHERE output_path IS NOT NULL
           GROUP BY output_path
          HAVING COUNT(*) > 1
        )`,
  ).run(SHARED_OUTPUT_REASON)
  return r.changes
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
/**
 * Owed a judgement: never scored, OR scored before the conversation moved on.
 *
 * The second half was missing and it let the earliest turn win by accident. A
 * chain is one unit of work and takes one verdict, so a session that scored a
 * root after its first turn — faithful, it had stopped and asked — kept that
 * verdict when turn two drifted and turn three corrected it. The drift became
 * invisible to the router, not because anyone judged it kindly but because
 * nothing asked again.
 *
 * Scores were already mutable (`ON CONFLICT DO UPDATE`), so the fix is not to
 * allow re-scoring but to ASK for it: a verdict recorded before the chain's
 * latest turn finished is stale, and stale is a kind of unscored.
 */
export const UNSCORED_WHERE =
  `r.status = 'ok' AND COALESCE(r.probe, 0) = 0 AND r.parent_run_id IS NULL
   AND COALESCE((SELECT c.status FROM run c WHERE c.parent_run_id = r.id
                  ORDER BY c.turn DESC LIMIT 1), r.status) <> 'running'
   AND (s.delivery IS NULL
        OR s.scored_at < (SELECT MAX(COALESCE(c.started_at, ''))
                            FROM run c WHERE c.parent_run_id = r.id))`

/** Join the one score owned by a conversation root to any of its turns. */
export function chainScoreJoin(runAlias: string, scoreAlias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(runAlias) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(scoreAlias)) {
    throw new Error('chain score aliases must be SQL identifiers')
  }
  return `LEFT JOIN score ${scoreAlias} ON ${scoreAlias}.run_id = ` +
    `COALESCE(${runAlias}.parent_run_id, ${runAlias}.id)`
}

/** Runs this session made that nobody has judged. */
export function pendingForSession(sid: string | null) {
  if (!sid) return []
  return db().query(
    `SELECT r.id, r.agent, r.job, r.repo, COALESCE(r.label, r.prompt_head) AS prompt_head
       FROM run r LEFT JOIN score s ON s.run_id = r.id
      WHERE r.session_id = ? AND ${UNSCORED_WHERE}
      ORDER BY r.id`,
  ).all(sid) as { id: number; agent: string; job: string; repo: string | null; prompt_head: string }[]
}

/** How many runs are owed a judgement, by the same rule, across every session. */
export function unscoredCount(sinceIso?: string): number {
  return (db().query(
    `SELECT COUNT(*) n FROM run r LEFT JOIN score s ON s.run_id = r.id
      WHERE ${UNSCORED_WHERE}${sinceIso ? ' AND r.started_at >= ?' : ''}`,
  ).get(...(sinceIso ? [sinceIso] : [])) as { n: number }).n
}

/**
 * A process that died mid-run leaves its row at 'running' for ever. Anything
 * older than this is treated as abandoned rather than live, so the dashboard
 * shows what is actually in flight.
 */
/**
 * Raised from 30 minutes when jobs gained their own bounds.
 *
 * Every bound must sit below this, or a run still working is swept out from
 * under a live process — which is why the suite asserts it. `implement` runs to
 * 45 minutes because building and then verifying a real change takes longer
 * than any review does.
 *
 * The cost of raising it is small: `reapStale` reaps a dead pid immediately
 * whatever the age, so this cutoff only governs rows whose pid is unknown or
 * recycled, and those are the cases where waiting longer is the safer error.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000

/** Test whether a recorded worker process still exists without touching it. */
export function pidAlive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * How long a pid-less `(pending)` row may sit before it is abandoned bootstrap.
 *
 * detach() inserts the reserved row, then spawns the worker, then records the
 * pid. A spawn error or a parent death in that gap leaves agent='(pending)',
 * status='running', no pid. That is not an agent run, and waiting for
 * STALE_AFTER_MS classified those as stale/interrupted. After this bound they
 * are failed/harness instead.
 */
export const PENDING_BOOTSTRAP_MS = 60_000

/**
 * When the terminal outcome of a conversation chain became observable.
 *
 * A root may inherit the last child's status, but it does not inherit that
 * child's timing. Read the terminal member itself: root arithmetic can put a
 * failure hours before or after it actually happened. Until the schema holds
 * an explicit terminal timestamp, a member without latency has no supportable
 * terminal time and returns null.
 */
export function chainTerminationAt(database: Database, memberId: number): string | null {
  const member = database.query('SELECT id, parent_run_id FROM run WHERE id=?').get(memberId) as
    { id: number; parent_run_id: number | null } | null
  if (!member) return null
  const rootId = member.parent_run_id ?? member.id
  const terminal = database.query(
    `SELECT started_at, latency_ms, status FROM run
      WHERE id=? OR parent_run_id=?
      ORDER BY turn DESC, id DESC LIMIT 1`,
  ).get(rootId, rootId) as
    { started_at: string; latency_ms: number | null; status: string } | null
  if (!terminal || !['ok', 'failed', 'stale'].includes(terminal.status) || terminal.latency_ms === null) {
    return null
  }
  return new Date(Date.parse(terminal.started_at) + terminal.latency_ms).toISOString()
}

/**
 * A root inherits the terminal status of the last turn of its chain.
 *
 * Counterpart of `resolveSupersededTurn` in run.ts, which is child-only and
 * cannot touch a root: the root is routing evidence, and giving it a terminal
 * status inserts a judgement. That is the point here, not an accident. A chain
 * that ended stale is a real outcome of a real agent; hiding it would make the
 * router's picture of that agent better than the truth.
 *
 * Chain structure only — no pid, no agent_pid, no process.kill. A worker exits
 * when it stops to ask, so those are dead for every asking run including live
 * ones. A root with an unanswered question is waiting, not stranded, and is
 * left alone. A last turn that is still `asking` is recoverable (`orch
 * continue`), not ended, so it is left alone too.
 *
 * The root may be `asking` after the first turn, or `ok`/`failed` while a
 * later resumed turn finishes. The old asking-only guard was part of DEV-146's
 * stranded-root repair; the unanswered-question and last-terminal-turn guards
 * now protect that case without blocking ordinary resumed roll-up. `stopped`
 * and `stale` roots remain locked because those lifecycle decisions must not
 * be undone by a worker finishing concurrently, and a `running` root is a live
 * first turn that a stale child row must never overwrite (lens run 2277).
 *
 * The terminal turn's error and failure_kind are part of that state and travel
 * with its status. The deliberate kind exception is a stale or abandoned child: DEV-146
 * established that stranding or abandoning a chain inserts a judgement on the
 * root, while copying the child's NOT_EVIDENCE kind would erase that judgement
 * from routing. Those lifecycle outcomes therefore retain the root's kind.
 */
export function resolveRootFromLastTurn(database: Database, rootId: number): number {
  return database.query(
    `UPDATE run AS root
        SET status = (
          SELECT last.status FROM run last
           WHERE last.id = root.id OR last.parent_run_id = root.id
           ORDER BY last.turn DESC, last.id DESC
           LIMIT 1
        ),
            error = (
          SELECT last.error FROM run last
           WHERE last.id = root.id OR last.parent_run_id = root.id
           ORDER BY last.turn DESC, last.id DESC
           LIMIT 1
        ),
            failure_kind = (
          SELECT CASE
                   WHEN last.status = 'stale' OR last.failure_kind = 'abandoned'
                     THEN root.failure_kind
                   ELSE last.failure_kind
                 END
            FROM run last
           WHERE last.id = root.id OR last.parent_run_id = root.id
           ORDER BY last.turn DESC, last.id DESC
           LIMIT 1
        )
      WHERE root.id = ?
        AND root.parent_run_id IS NULL
        AND root.status IN ('asking', 'ok', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM question q JOIN run owner ON owner.id = q.run_id
           WHERE (owner.id = root.id OR owner.parent_run_id = root.id)
             AND q.answered_at IS NULL
        )
        AND (
          SELECT last.status FROM run last
           WHERE last.id = root.id OR last.parent_run_id = root.id
           ORDER BY last.turn DESC, last.id DESC
           LIMIT 1
        ) IN ('ok', 'failed', 'stale')`,
  ).run(rootId).changes
}

/**
 * A run only writes its terminal state on the normal path, so a process that is
 * killed — or whose session ends — leaves its row claiming to be live for ever.
 * Those rows inflate "in flight" and hide in `--unscored`, so they are swept to
 * a distinct status rather than silently counted as either running or failed.
 *
 * Liveness is checked by PID where one was recorded — a dead process is dead
 * now, not in thirty minutes. A live PID always wins over the age fallback;
 * treating a demonstrably live worker as stale transfers authority while it
 * is still working. The cutoff applies only to rows that have no PID.
 *
 * Returns how many were swept. Called opportunistically on open: cheap, and it
 * means no separate cron has to remember.
 */
export type ObservedDeadRun = { id: number; reason: string }

export function reapStale(d: Database = db()): number | ObservedDeadRun[] {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString()
  const bootstrapCutoff = new Date(Date.now() - PENDING_BOOTSTRAP_MS).toISOString()
  const rows = d
    .query(`SELECT id, pid, agent, started_at FROM run WHERE status='running'`)
    .all() as { id: number; pid: number | null; agent: string; started_at: string }[]

  const dead: number[] = []
  const abandonedBootstrap: number[] = []
  for (const r of rows) {
    // A pid-less `(pending)` row is abandoned bootstrap, not an agent run.
    // Checked before the hour cutoff so these are failed/harness rather than
    // waiting for stale/interrupted.
    if (!r.pid && r.agent === '(pending)' && r.started_at < bootstrapCutoff) {
      abandonedBootstrap.push(r.id)
      continue
    }
    // signal 0 tests existence without touching the process. A live PID is
    // authoritative whatever the row's age; only PID-less legacy rows fall
    // back to the clock.
    if (r.pid) {
      if (!pidAlive(r.pid)) dead.push(r.id)
      continue
    }
    if (r.started_at < cutoff) dead.push(r.id)
  }
  if (linkedWorktreeReadOnly) {
    return [
      ...dead.map((id) => {
        const row = rows.find((candidate) => candidate.id === id)!
        return { id, reason: row.pid ? `pid ${row.pid} is not alive` : `no pid after ${STALE_AFTER_MS}ms` }
      }),
      ...abandonedBootstrap.map((id) => ({
        id, reason: `pending row had no pid after ${PENDING_BOOTSTRAP_MS}ms`,
      })),
    ]
  }
  if (abandonedBootstrap.length) {
    const update = d.query(
      `UPDATE run SET status='failed', failure_kind='harness',
              error='the worker process never started' WHERE id=? AND status='running'`,
    )
    for (const id of abandonedBootstrap) {
      writeTransaction(() => {
        if (update.run(id).changes !== 1) return
        const authority = runMutationAuthority(d, id)
        auditRunMutation(authority, 'reap', `pending row had no pid after ${PENDING_BOOTSTRAP_MS}ms`, d)
      }, d)
    }
  }
  if (dead.length) {
    // Stamped `interrupted`, which puts these under the same NOT_EVIDENCE rule as
    // an exit-143 kill instead of leaving routing a second concept to know about.
    //
    // A reaped row can ONLY be an external kill, and the two facts that make that
    // airtight are both already enforced: every agent's timeout is held below
    // STALE_AFTER_MS (asserted in the suite), so a genuine hang is caught by the
    // agent's own timer and recorded as `timeout` - which IS evidence - and
    // run()'s try/finally writes a terminal row on any normal exit and on
    // SIGTERM. Reaching here means neither could run: SIGKILL, or the parent's
    // process group going down and taking the child with it.
    //
    // Run 521 is the worked example. A delegation in this very session was killed
    // by the calling harness's command timeout and landed here - a fact about the
    // caller, charged until now to qwen-local.
    const update = d.query(
      `UPDATE run SET status='stale', failure_kind='interrupted',
              error='abandoned: process gone, no terminal state recorded'
        WHERE id=? AND status='running'`,
    )
    for (const id of dead) {
      const row = rows.find((candidate) => candidate.id === id)!
      writeTransaction(() => {
        if (update.run(id).changes !== 1) return
        const authority = runMutationAuthority(d, id)
        auditRunMutation(authority, 'reap',
          row.pid ? `pid ${row.pid} is not alive` : `no pid after ${STALE_AFTER_MS}ms`, d)
      }, d)
    }
  }
  const ended = [...dead, ...abandonedBootstrap]
  if (ended.length) {
    const roots = d.query(
      `SELECT DISTINCT COALESCE(parent_run_id, id) AS id FROM run
        WHERE id IN (${ended.map(() => '?').join(',')})`,
    ).all(...ended) as { id: number }[]
    for (const { id } of roots) resolveRootFromLastTurn(d, id)
  }
  return dead.length + abandonedBootstrap.length
}

export type Delivery = 'none' | 'partial' | 'full'
export type Quality = 'wrong' | 'mixed' | 'right'
/** Did it build what it was asked to build, or something it decided on instead? */
export type Fidelity = 'drifted' | 'partial' | 'faithful'

/**
 * What each cell of the matrix is worth to the router.
 *
 * Read down the rows: a run that never delivered is NEGATIVE, not merely zero,
 * because it is a different kind of failure from a wrong answer. A wrong answer
 * means the agent engaged with the job and got it wrong — it stays a reasonable
 * candidate that happens to be weaker. Nothing arriving means a plumbing or
 * capability mismatch, and that should actively push routing away rather than
 * merely fail to pull it closer, or an agent that CANNOT do a job ranks level
 * with one that does it badly.
 *
 * The three cells the old vocabulary could express keep their exact old values,
 * so migrating changed no agent's standing:
 *
 *     good     -> full/right    1
 *     partial  -> full/mixed    0.5
 *     bad      -> full/wrong    0
 *     unusable -> none         -0.5
 *
 * The partial-delivery row is new, and it is the row that was missing. Run 264
 * lives there: it answered correctly but never fetched the step body it was
 * told to follow, so the answer was right as far as it went and stopped early.
 * Under one axis that was `partial`, the same score as an answer that arrived
 * whole and was half wrong.
 *
 * Deliberately coarse. Three levels an axis is what a person can apply the same
 * way twice, months apart, which matters more than resolution when the whole
 * corpus is 1,425 judgements (`orch stats`, measured 2026-09-06) and five
 * decide a route.
 */
export const WEIGHT: Record<Delivery, Record<Quality, number> | number> = {
  none: -0.5,
  partial: { wrong: -0.25, mixed: 0.25, right: 0.5 },
  full: { wrong: 0, mixed: 0.5, right: 1 },
}

/**
 * What FIDELITY costs when it is judged at all.
 *
 * A penalty rather than a third dimension of the matrix, and the shape is the
 * argument. Delivery and quality are genuinely two questions about one event —
 * did an answer arrive, and was it right — and the matrix exists because their
 * combinations mean different things. Fidelity is not a third such question; it
 * is a discount on an answer that is already good. Correct, working, tested
 * code that solves a different problem is not "half right", it is right about
 * the wrong thing, and the honest encoding is full marks minus what the drift
 * cost.
 *
 * Half a judgement for total drift, matched to one quality step, because that
 * is what it is worth: an implementation that solved the wrong problem is about
 * as useful as one that solved the right problem badly, and both leave the
 * architect with rework rather than with nothing.
 *
 * ESCALATING IS NOT DRIFT. A worker that stopped and asked, then built what it
 * was told, is `faithful` and pays nothing — that promise is made explicitly in
 * the preamble the worker reads, and it has to hold here or asking would cost
 * something after all and nobody would ask.
 */
export const FIDELITY_PENALTY: Record<Fidelity, number> = {
  faithful: 0,
  partial: -0.25,
  drifted: -0.5,
}

/**
 * What one judgement is worth. Null quality is only legal with delivery 'none'.
 *
 * Fidelity is optional and absent for every read-only job, so the two-axis
 * arithmetic is untouched by its introduction: an existing score with no
 * fidelity weighs exactly what it always did, and no agent's standing moved
 * when the column was added.
 */
export function weigh(
  delivery: Delivery,
  quality: Quality | null,
  fidelity: Fidelity | null = null,
): number {
  const row = WEIGHT[delivery]
  const base = typeof row === 'number' ? row : row[quality ?? 'wrong']
  // An unknown level is not a zero penalty. Reading it as "no penalty" would
  // quietly flatter a run nobody judged.
  const pen = fidelity ? FIDELITY_PENALTY[fidelity] : 0
  if (fidelity && pen === undefined) {
    throw new Error(`unknown fidelity "${fidelity}": expected ${FIDELITY.join(' | ')}`)
  }
  /**
   * NOTHING ARRIVING IS THE FLOOR, and the penalty must not dig under it.
   *
   * Unclamped, `partial/wrong/drifted` weighs -0.75 — worse than `none`, which
   * is -0.5. That inverts the rule this matrix is built on: no answer is
   * negative because the agent cannot do the job here, while a wrong answer is
   * merely weak evidence that it engaged. An agent that delivered something
   * unusable would rank BELOW one that delivered nothing at all, and routing
   * would prefer the agent that cannot do the job.
   */
  return Math.max(base + pen, WEIGHT.none as number)
}

/** The best a judgement can be, so a percentage has a denominator. */
export const WEIGHT_MAX = 1

/**
 * The vocabulary, in one place.
 *
 * The previous four-verdict scale had `unusable` in the schema and offered it
 * nowhere anyone was scoring — the CLI hint, the run-completion line, the Stop
 * hook and the gate's deny message all said `good|partial|bad`. It was used once
 * in fifty-eight judgements, and a run that returned 57 bytes of vendor error
 * was filed as a quality problem because nothing better was on offer. Exported
 * from here so a level cannot exist that the prompts do not mention.
 */
export const DELIVERY: Delivery[] = ['none', 'partial', 'full']
export const QUALITY: Quality[] = ['wrong', 'mixed', 'right']
export const FIDELITY: Fidelity[] = ['drifted', 'partial', 'faithful']

/** Words that name a question-shaped field without asking a question. */
export const GENERIC_QUESTION_TOKENS = ['placeholder', 'tbd', 'question', 'todo'] as const

/**
 * Whether the caller is allowed to judge a run.
 *
 * The rule this enforces is already written down — "only that session can judge
 * it, because only it read the output" — and being written down was not enough.
 * Two sessions scored each other's runs within one hour on 2026-08-31, both by
 * the same route: `orch do` prints a run id only when a long run FINISHES, so
 * during a parallel fan-out you hold outputs with no ids, and "my second block
 * of ids continues my first" is the obvious inference. It is wrong precisely
 * when a concurrent session's runs have interleaved into the gap, which is the
 * case nobody pictures. Neither session had any intent to score another's work.
 *
 * That is why `foreign` is worth blocking rather than merely warning: the error
 * corrects a mistaken belief. Anyone who reads "run 331 was made by session X,
 * you are session Y" and proceeds anyway is no longer making this mistake.
 *
 * The two unknown cases are deliberately NOT blocked. Refusing them would
 * strand every run recorded before session ids existed, and every run scored
 * from a plain shell — punishing missing evidence as though it were evidence of
 * wrongdoing, and pushing people toward the override for honest reasons.
 */
export type Judgeability =
  /** The caller made this run. */
  | { verdict: 'own' }
  /** The run predates session recording, or was made without the env var. */
  | { verdict: 'unattributed' }
  /** The caller has no session id, so ownership cannot be established. */
  | { verdict: 'anonymous'; owner: string }
  /** The run belongs to a different session, and both ids are known. */
  | { verdict: 'foreign'; owner: string }

export function judgeability(
  runSession: string | null,
  caller: string | null,
): Judgeability {
  if (!runSession) return { verdict: 'unattributed' }
  if (!caller) return { verdict: 'anonymous', owner: runSession }
  return runSession === caller
    ? { verdict: 'own' }
    : { verdict: 'foreign', owner: runSession }
}

export type DuelJobMatrix = {
  job: string
  agents: string[]
  cells: Record<string, Record<string, { wins: number; losses: number }>>
}

export function parseRunIds(value: string, flagName: string): number[] {
  if (!value) throw new Error(`${flagName} needs at least one run id`)
  const ids = value.split(',').map((part) => {
    if (!/^\d+$/.test(part) || Number(part) < 1) {
      throw new Error(`${flagName} needs run ids separated by commas, got '${value}'`)
    }
    return Number(part)
  })
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${flagName} names the same run more than once`)
  }
  return ids
}

function validateComparisons(
  runId: number,
  otherRunIds: number[],
  callerSession: string | null,
  force = false,
): { job: string } {
  writableDb()
  const ids = [runId, ...otherRunIds]
  const rows = db().query(
    `SELECT id, job, session_id FROM run WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as { id: number; job: string; session_id: string | null }[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of ids) {
    if (!byId.has(id)) throw new Error(`no run ${id}`)
  }
  const subject = byId.get(runId)!
  for (const otherId of otherRunIds) {
    if (otherId === runId) {
      throw new Error(`run ${runId} cannot be better than itself`)
    }
    const other = byId.get(otherId)!
    if (other.job !== subject.job) {
      throw new Error(
        `runs ${runId} and ${otherId} cannot be compared: ` +
        `jobs differ (${subject.job} and ${other.job})`,
      )
    }
  }
  if (!force) {
    for (const row of rows) {
      const owner = judgeability(row.session_id, callerSession)
      if (owner.verdict === 'foreign') {
        throw new Error(
          `run ${row.id} was made by another session - you did not read its output.\n` +
          `  its session:   ${owner.owner}\n` +
          `  your session:  ${callerSession}\n\n` +
          `Both runs in a duel must be scoreable by this session; --force overrides.`,
        )
      }
    }
  }
  return { job: subject.job }
}

/** Record one winner against every named loser after validating the comparison. */
export function recordDuels(
  winnerRunId: number,
  loserRunIds: number[],
  callerSession: string | null,
  at: string,
  force = false,
): void {
  const winner = validateComparisons(winnerRunId, loserRunIds, callerSession, force)
  const insert = db().query(
    `INSERT INTO duel (job, winner_run_id, loser_run_id, session_id, at)
     VALUES (?,?,?,?,?) ON CONFLICT(winner_run_id, loser_run_id) DO NOTHING`,
  )
  writeTransaction(() => {
    for (const loserId of loserRunIds) {
      insert.run(winner.job, winnerRunId, loserId, callerSession, at)
      recordComparedPair(winnerRunId, loserId, at)
    }
  })
}

/** Record every named winner over one loser after validating the whole set. */
export function recordLosses(
  loserRunId: number,
  winnerRunIds: number[],
  callerSession: string | null,
  at: string,
  force = false,
): void {
  const loser = validateComparisons(loserRunId, winnerRunIds, callerSession, force)
  const insert = db().query(
    `INSERT INTO duel (job, winner_run_id, loser_run_id, session_id, at)
     VALUES (?,?,?,?,?) ON CONFLICT(winner_run_id, loser_run_id) DO NOTHING`,
  )
  writeTransaction(() => {
    for (const winnerId of winnerRunIds) {
      insert.run(loser.job, winnerId, loserRunId, callerSession, at)
      recordComparedPair(winnerId, loserRunId, at)
    }
  })
}

function orderedPair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a]
}

/** Mark scored roots as compared without adding directional duel evidence. */
export function recordTies(
  runId: number,
  otherRunIds: number[],
  callerSession: string | null,
  at: string,
  force = false,
): void {
  validateComparisons(runId, otherRunIds, callerSession, force)
  writeTransaction(() => {
    for (const otherId of otherRunIds) recordComparedPair(runId, otherId, at)
  })
}

function recordComparedPair(a: number, b: number, at: string): void {
  const [runA, runB] = orderedPair(a, b)
  db().query(
    `INSERT INTO compared_pair (run_a_id, run_b_id, compared_at) VALUES (?,?,?)
     ON CONFLICT(run_a_id, run_b_id) DO NOTHING`,
  ).run(runA, runB, at)
}

export type PairPartner = { id: number; agent: string; reason: string }
export type UnrecordedPair = {
  runId: number; partnerId: number; partnerAgent: string; reason: string
}

const PAIR_REASON_SQL = `CASE
  WHEN subject.lens IS NOT NULL AND subject.input_tree IS NOT NULL
       AND partner.input_tree IS NOT NULL
    THEN 'same task prompt and lens; same input tree'
  WHEN subject.lens IS NOT NULL
    THEN 'same task prompt and lens; at least one input tree unrecorded'
  WHEN subject.input_tree IS NOT NULL AND partner.input_tree IS NOT NULL
    THEN 'same task prompt; same input tree'
  ELSE 'same task prompt; at least one input tree unrecorded'
END`

/** Scored sibling roots for the same task in this session, not yet compared. */
export function pairPartners(runId: number, sid: string | null): PairPartner[] {
  if (!sid) return []
  return db().query(
    `SELECT partner.id, partner.agent, ${PAIR_REASON_SQL} AS reason
       FROM run subject
       JOIN run partner ON partner.id <> subject.id
        AND partner.parent_run_id IS NULL
        AND partner.job = subject.job
        AND partner.session_id = ?
        AND COALESCE(partner.probe, 0) = 0
        AND partner.evidence_excluded IS NULL
        AND subject.spec_sha IS NOT NULL
        AND partner.spec_sha = subject.spec_sha
        AND (subject.lens IS partner.lens)
        AND (subject.input_tree IS NULL OR partner.input_tree IS NULL
             OR partner.input_tree = subject.input_tree)
       JOIN score partner_score ON partner_score.run_id = partner.id
       LEFT JOIN compared_pair compared
         ON compared.run_a_id = MIN(subject.id, partner.id)
        AND compared.run_b_id = MAX(subject.id, partner.id)
      WHERE subject.id = ?
        AND COALESCE(subject.probe, 0) = 0
        AND subject.evidence_excluded IS NULL
        AND datetime(partner_score.scored_at) >= datetime('now', '-24 hours')
        AND compared.run_a_id IS NULL
      ORDER BY partner.id`,
  ).all(sid, runId) as PairPartner[]
}

/** Each recent, scored, comparable pair once, oriented toward the newer run. */
export function unrecordedPairsForSession(sid: string | null): UnrecordedPair[] {
  if (!sid) return []
  return db().query(
    `SELECT newer.id AS runId, older.id AS partnerId, older.agent AS partnerAgent,
            ${PAIR_REASON_SQL.replaceAll('subject.', 'newer.').replaceAll('partner.', 'older.')} AS reason
       FROM run newer
       JOIN score newer_score ON newer_score.run_id = newer.id
       JOIN run older ON older.id < newer.id
        AND older.parent_run_id IS NULL
        AND older.job = newer.job
        AND older.session_id = newer.session_id
        AND COALESCE(older.probe, 0) = 0
        AND older.evidence_excluded IS NULL
        AND newer.spec_sha IS NOT NULL
        AND older.spec_sha = newer.spec_sha
        AND (newer.lens IS older.lens)
        AND (newer.input_tree IS NULL OR older.input_tree IS NULL
             OR older.input_tree = newer.input_tree)
       JOIN score older_score ON older_score.run_id = older.id
       LEFT JOIN compared_pair compared
         ON compared.run_a_id = older.id AND compared.run_b_id = newer.id
      WHERE newer.parent_run_id IS NULL AND newer.session_id = ?
        AND COALESCE(newer.probe, 0) = 0
        AND newer.evidence_excluded IS NULL
        AND datetime(newer_score.scored_at) >= datetime('now', '-24 hours')
        AND datetime(older_score.scored_at) >= datetime('now', '-24 hours')
        AND compared.run_a_id IS NULL
      ORDER BY newer.id, older.id`,
  ).all(sid) as UnrecordedPair[]
}

/** The directed duel evidence, grouped into one agent-by-agent matrix per job. */
export function duelMatrices(jobName?: string): DuelJobMatrix[] {
  const rows = db().query(
    `SELECT d.job, winner.agent AS winner, loser.agent AS loser, COUNT(*) AS n
       FROM duel d
       JOIN run winner ON winner.id = d.winner_run_id
       JOIN run loser ON loser.id = d.loser_run_id
      WHERE (? IS NULL OR d.job = ?)
      GROUP BY d.job, winner.agent, loser.agent
      ORDER BY d.job, winner.agent, loser.agent`,
  ).all(jobName ?? null, jobName ?? null) as
    { job: string; winner: string; loser: string; n: number }[]
  const jobs = new Map<string, DuelJobMatrix>()
  for (const row of rows) {
    let matrix = jobs.get(row.job)
    if (!matrix) {
      matrix = { job: row.job, agents: [], cells: {} }
      jobs.set(row.job, matrix)
    }
    for (const agent of [row.winner, row.loser]) {
      if (!matrix.agents.includes(agent)) matrix.agents.push(agent)
    }
  }
  for (const matrix of jobs.values()) {
    matrix.agents.sort()
    for (const a of matrix.agents) {
      matrix.cells[a] = {}
      for (const b of matrix.agents) matrix.cells[a]![b] = { wins: 0, losses: 0 }
    }
  }
  for (const row of rows) {
    const matrix = jobs.get(row.job)!
    matrix.cells[row.winner]![row.loser]!.wins += row.n
    matrix.cells[row.loser]![row.winner]!.losses += row.n
  }
  return [...jobs.values()]
}
