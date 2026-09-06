import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DOC_SCOPES, DOC_SCOPE_SUBJECT_KIND } from '../../shared/docs.ts'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  DATABASE_RESOLUTION, DB_PATH, missingDatabaseMessage, registeredRepositoryMissingDatabase,
} from './database-location.ts'
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

const sqlValues = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',')

export const RUN_MUTATION_ACTIONS = [
  'adopt', 'answer', 'tell', 'stop', 'abandon', 'discard', 'sweep', 'reap', 'void', 'score', 'rescore',
  'retry', 'continue', 'reclassify', 'canon-eval',
] as const
export type RunMutationAction = typeof RUN_MUTATION_ACTIONS[number]
const RUN_MUTATION_ACTION_SQL = RUN_MUTATION_ACTIONS.map((action) => `'${action}'`).join(',')
export type RootAuthority = {
  runId: number; rootId: number; owner: string | null; actor: string | null
}

let handle: Database | null = null
let connectionWritable: boolean | null = null

export const LINKED_WORKTREE_WRITE_REFUSAL =
  'refusing to write the live store from a linked worktree; set ORCH_DB explicitly ' +
  '(a copy for experiments, or the live path to insist)'

export const linkedWorktreeReadOnly =
  DATABASE_RESOLUTION.linkedWorktreeBinary && DATABASE_RESOLUTION.method !== 'ORCH_DB'

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

export function db(writable = false): Database {
  if (writable && linkedWorktreeReadOnly) throw new Error(LINKED_WORKTREE_WRITE_REFUSAL)
  if (handle) return handle
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
  const registered = d.query('SELECT path FROM project WHERE name = ?').get(PLATFORM_SLUG) as
    { path: string } | null
  DATABASE_RESOLUTION.registeredPath = registered ? join(registered.path, 'orchestrator', 'orch.db') : null
  const registeredMissing = registered
    ? registeredRepositoryMissingDatabase(DATABASE_RESOLUTION, registered.path)
    : null
  if (registeredMissing) {
    d.close()
    throw new Error(missingDatabaseMessage(registeredMissing))
  }
  if (!linkedWorktreeReadOnly && databaseWritable(d)) {
    d.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 100;
      PRAGMA journal_size_limit = 1048576;
    `)
    applySchema(d)
    excludeSharedOutputRuns(d)
    seedProjects(d)
  } else if (linkedWorktreeReadOnly && canonicalSchemaMismatch(d)) {
    console.error('warning: canonical schema mismatch; opened the live store read-only')
  }
  handle = d
  if (connectionWritable) reapStale(d)
  return d
}

/** Open the only sanctioned multi-statement write transaction. */
export function writeTransaction<T>(fn: () => T, database: Database = db()): T {
  return database.transaction(fn).immediate()
}

/** The sole path that may create the orchestrator database. */
export function initializeDatabase(): string {
  if (linkedWorktreeReadOnly) throw new Error(LINKED_WORKTREE_WRITE_REFUSAL)
  if (existsSync(DB_PATH)) throw new Error(`refusing to initialize: orchestrator database already exists: ${DB_PATH}`)
  if (!DATABASE_RESOLUTION.initializable) {
    throw new Error(`refusing to initialize from a worktree binary: ${DB_PATH}\nrun orch init-db from the main checkout`)
  }
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const d = new Database(DB_PATH, { create: true })
  try {
    d.exec('PRAGMA foreign_keys = ON;')
    applySchema(d)
    excludeSharedOutputRuns(d)
    seedProjects(d)
  } finally {
    d.close()
  }
  return DB_PATH
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

/**
 * CREATE TABLE plus every addColumn, then a one-time rebuild if the live
 * sqlite_master DDL is not the canonical one. db() calls this after opening
 * the file; tests call it on a fixture.
 */
export function applySchema(d: Database): void {
  migrate(d)
  addColumn(d, 'run', 'prompt_path', 'TEXT')
  addColumn(d, 'run', 'pid', 'INTEGER')
  addColumn(d, 'run', 'agent_pid', 'INTEGER')
  addColumn(d, 'run', 'session_id', 'TEXT')
  // An answered question remains undelivered until detach atomically claims
  // the resumed turn. This closes the process-exit gap between ruling and
  // dispatch without inventing replay machinery.
  addColumn(d, 'question', 'delivery_pending_at', 'TEXT')
  // A caller-supplied name for distinguishing sibling runs in a fan-out.
  addColumn(d, 'run', 'label', 'TEXT')
  // Which run this one re-attempts. A transient failure — a quota limit, a
  // dropped connection — should be retried on the SAME agent, not silently
  // re-routed to a different one; this is how the two are told apart later.
  addColumn(d, 'run', 'retry_of', 'INTEGER')
  // Inputs a later process needs to start the same work from scratch. A
  // failover may happen after an asking turn, when the original CLI flags are
  // no longer in memory, so these belong with mcp and schema_path on the run.
  addColumn(d, 'run', 'launch_cwd', 'TEXT')
  addColumn(d, 'run', 'launch_seed', 'TEXT')
  addColumn(d, 'run', 'launch_key', 'TEXT')
  addColumn(d, 'run', 'launch_base', 'TEXT')
  addColumn(d, 'run', 'no_failover', 'INTEGER NOT NULL DEFAULT 0')
  // retry_of also serves the deliberate `orch retry` command. This flag says
  // which linked rows were created by the automatic vendor-failure policy.
  addColumn(d, 'run', 'automatic_failover', 'INTEGER NOT NULL DEFAULT 0')
  // Why this agent was picked. Held only in memory before, which was fine
  // while `orch do` printed it itself - it no longer runs the agent in its
  // own process, so the row has to carry it.
  addColumn(d, 'run', 'route_reason', 'TEXT')
  // The branch the work was on. Free evidence that was being discarded: 53 of
  // this estate's 60 branches carry a ticket key, and a branch name is a
  // declaration in the same way a worktree path is.
  addColumn(d, 'run', 'branch', 'TEXT')
  // Set when cleanup removed the disposable worktree but deliberately retained
  // an architect's commits because they have not reached the project's trunk.
  addColumn(d, 'run', 'branch_kept', 'TEXT')
  // The exact recovery point when cleanup could not restore a retained branch.
  addColumn(d, 'run', 'branch_kept_tip', 'TEXT')
  // Where a writing worker was put, and the branch it was given. A run that
  // edited files is only readable afterwards if the tree it edited can be
  // found again, and `orch discard` needs both to clean up.
  addColumn(d, 'run', 'worktree', 'TEXT')
  // Which lifecycle made the tree determines which lifecycle may remove it.
  addColumn(d, 'run', 'worktree_source', "TEXT CHECK (worktree_source IN ('recipe','git','readonly_recipe'))")
  // The VENDOR's own id for the conversation, which is what makes an escalation
  // affordable: answering a design question resumes the worker where it stopped
  // instead of restarting it against the same files.
  addColumn(d, 'run', 'vendor_session', 'TEXT')
  // The commit the worktree was cut from. Without it the diff has no fixed
  // floor: reading it against whatever HEAD happens to be later would show the
  // worker's changes tangled with everything that landed since.
  addColumn(d, 'run', 'base_commit', 'TEXT')
  // What the caller's checkout contributed before the worker started. The
  // boolean is explicit so a clean carry is recorded rather than confused with
  // an old/read-only row that has no carry audit. Paths are JSON because git
  // permits names that cannot be represented safely by a separator.
  addColumn(d, 'run', 'carry_happened', 'INTEGER')
  addColumn(d, 'run', 'carry_base_commit', 'TEXT')
  addColumn(d, 'run', 'carry_tracked_paths', 'TEXT')
  addColumn(d, 'run', 'carry_untracked_paths', 'TEXT')
  // A multi-turn implementation is ONE unit of work. The first turn is the
  // root; every ruling that resumes it adds a child. Routing and scoring count
  // the root alone — see `evidenceWhere` — because three turns of one
  // conversation are one piece of evidence about an agent, and counting them
  // separately would let an agent cross the routing threshold by asking a lot
  // of questions.
  addColumn(d, 'run', 'parent_run_id', 'INTEGER')
  addColumn(d, 'run', 'turn', 'INTEGER NOT NULL DEFAULT 1')

  /**
   * FACTS ABOUT A WRITING RUN, recorded without anyone's opinion.
   *
   * These are the half of the judgement model that needs no judgement, and the
   * literature is emphatic that they are the half that works: execution-based
   * verification catches unfaithful implementation where a model reading a diff
   * and pronouncing on it does not. A verdict is one person's reading; "the
   * tests passed" and "it touched four files the spec never mentioned" are
   * facts, they cost nothing to collect, and they are the ones that make the
   * scores comparable across agents rather than across moods.
   *
   * Nullable throughout, because a read-only run has none of them and inventing
   * a zero would put a fact in the table that nobody observed.
   */
  addColumn(d, 'run', 'files_changed', 'INTEGER')
  addColumn(d, 'run', 'changed_paths', 'TEXT')
  addColumn(d, 'run', 'lines_added', 'INTEGER')
  addColumn(d, 'run', 'lines_removed', 'INTEGER')
  // What the worker SAYS about its own tests. Its claim, not our measurement —
  // which is why it is stored beside the diff rather than instead of it.
  addColumn(d, 'run', 'tests_ran', 'INTEGER')
  addColumn(d, 'run', 'tests_passed', 'INTEGER')
  // Deviations it owned up to, and questions it asked. Both are counted because
  // the interesting ratio is between them: a worker that reports no deviations
  // AND asked nothing on a genuinely ambiguous spec did not avoid the
  // ambiguity, it resolved it silently.
  addColumn(d, 'run', 'deviations', 'INTEGER')
  addColumn(d, 'run', 'escalations', 'INTEGER')
  // The stack this run's work was in, resolved when the run is recorded rather
  // than joined at read time. A project can be re-registered with a different
  // stack, and re-deriving old runs through the new value would rewrite history
  // — evidence belongs to the stack it was actually gathered in.
  addColumn(d, 'run', 'stack', 'TEXT')
  addColumn(d, 'review', 'tier', 'INTEGER')
  addColumn(d, 'review', 'tier_risk', 'INTEGER')
  addColumn(d, 'review', 'tier_size', 'INTEGER')
  addColumn(d, 'review', 'tier_reasons', 'TEXT')
  addColumn(d, 'review', 'tier_reason', 'TEXT')
  // WHICH MODEL actually ran. An agent is a harness; the model is what is being
  // judged, and both subscriptions carry more than one. Without this, changing
  // a CLI's configured model silently rewrites the meaning of every score
  // already recorded against that agent.
  addColumn(d, 'run', 'model', 'TEXT')
  // The caller's --mcp and --schema, so `orch retry` can re-send a read-only
  // run with the same tools and contract. Not derived: a writing job always
  // uses MCP, and retry of those is refused rather than reconstructed.
  addColumn(d, 'run', 'mcp', 'INTEGER')
  // A request is not evidence that the canonical source reached the worker.
  // Keep the same-named project server and its observed connection separately.
  addColumn(d, 'run', 'mcp_server', 'TEXT')
  addColumn(d, 'run', 'mcp_connected', 'INTEGER')
  addColumn(d, 'run', 'mcp_error', 'TEXT')
  addColumn(d, 'run', 'schema_path', 'TEXT')
  addColumn(d, 'run', 'docs_injected', 'INTEGER')
  addColumn(d, 'run', 'doc_revisions', 'TEXT')
  addColumn(d, 'run', 'canon_sha', 'TEXT')
  const hadDocDelivery = (d.query("PRAGMA table_info('doc')").all() as { name: string }[])
    .some((column) => column.name === 'delivery')
  addColumn(d, 'doc', 'delivery', "TEXT NOT NULL DEFAULT 'inject'")
  addColumn(d, 'doc_revision', 'delivery', "TEXT NOT NULL DEFAULT 'inject'")
  if (!hadDocDelivery) {
    const changed = d.query(`SELECT * FROM doc WHERE delivery='inject' AND scope='global' AND slug IN
      ('port-category-map','port-import-exclusions','port-import-source-context','port-ref-metadata','port-state-metadata')`).all() as {
        id: number; scope: string; subject: string | null; slug: string; title: string; body: string
      }[]
    const at = nowIso()
    writeTransaction(() => {
      for (const doc of changed) {
        d.query("UPDATE doc SET delivery='demand', updated_at=? WHERE id=?").run(at, doc.id)
        d.query(`INSERT INTO doc_revision
          (doc_id,scope,subject,slug,op,title,body,delivery,author,reason,session_id,at)
          VALUES (?,?,?,?,?,?,?,'demand','migration',?,NULL,?)`).run(
          doc.id, doc.scope, doc.subject, doc.slug, 'set', doc.title, doc.body,
          'DEV-254: port importer docs are fetched by slug, not injected', at,
        )
      }
    }, d)
  }
  // Stable machine identity for findings-producing review jobs. A display label
  // is deliberately not used as a calibration key.
  addColumn(d, 'run', 'lens', 'TEXT')
  // A per-run secret, so the globally-registered ask server can tell a real
  // worker from any other process that launched it with a guessed run id. A
  // run id is an identifier and is printed in every listing; it was never a
  // credential.
  addColumn(d, 'run', 'run_token', 'TEXT')
  /**
   * THIS RUN IS NOT EVIDENCE ABOUT AN AGENT, and the text is why.
   *
   * Separate from `probe`, which means a deliberate calibration run. These
   * were not that: a clock-based filename collided, several runs shared one
   * output file, and the last to finish overwrote the rest. Anyone who then
   * read `orch result` — and some who SCORED — was looking at another run's
   * work. The verdict stays; it simply stops counting toward routing.
   *
   * NULL means it counts. Any text means it does not.
   */
  addColumn(d, 'run', 'evidence_excluded', 'TEXT')
  // JSON changes in registered main-checkout porcelain state observed while
  // the worker was alive. `[]` means the check ran and found nothing; NULL is
  // reserved for old rows and runs that ended before observation could start.
  addColumn(d, 'run', 'outside_worktree_writes', 'TEXT')
  // The complete worktree content presented to a repository worker, measured
  // by orch immediately before the vendor process starts.
  addColumn(d, 'run', 'input_tree', 'TEXT')
  // The commit whose tree a repository review was dispatched against. Review
  // recording pins it so a content-preserving rebase cannot orphan the object.
  addColumn(d, 'run', 'head_commit', 'TEXT')
  // The caller's explicit review address, kept separately from the resolved
  // commit so provenance preserves whether a branch or run id was requested.
  addColumn(d, 'run', 'review_ref', 'TEXT')
  addColumn(d, 'review_lens', 'reviewed_tree', 'TEXT')
  addColumn(d, 'review_finding', 'triaged_severity', 'TEXT')
  // A completed target task must keep its provenance. NULL is still active;
  // an ISO timestamp is resolved, so absence never has to stand for completion.
  addColumn(d, 'port_ref', 'resolved_at', 'TEXT')
  addColumn(d, 'monitor_condition', 'severity',
    `TEXT CHECK (severity IS NULL OR severity IN (${sqlValues(MONITOR_SEVERITY)}))`)
  // Runs AFTER every addColumn, so the rebuilt table carries the whole current
  // column set rather than whatever migrate() happened to declare.
  ensureCanonicalSchema(d)
}

/**
 * Fill the project register ONCE, from what this database already knows.
 *
 * The register has to start somewhere, and asking a person to re-enter four
 * projects the tool has recorded runs against for months would be a poor
 * introduction.
 *
 * THIS IS DATA, NOT CODE, and that distinction is the whole point of the change
 * — it would be easy to lose right here. The old regex was code that knew where
 * projects live; this is a migration that runs once against one machine's
 * history and leaves rows behind. A fresh checkout on somebody else's machine
 * has no run history, seeds nothing, and starts with an empty register and
 * `orch project add`, which is the intended experience rather than a degraded
 * one.
 *
 * Skipped once anything is registered, so a person's own edits are never
 * overwritten by a later reseed.
 */
function seedProjects(d: Database) {
  const { n } = d.query('SELECT COUNT(*) AS n FROM project').get() as { n: number }
  if (n > 0) return

  // Distinct repos with each one's most recent working directory — the only
  // record here of where that project actually sits on disk.
  const rows = d.query(
    `SELECT repo, cwd FROM run r
      WHERE repo IS NOT NULL AND cwd IS NOT NULL
        AND id = (SELECT MAX(id) FROM run x WHERE x.repo = r.repo AND x.cwd IS NOT NULL)`,
  ).all() as { repo: string; cwd: string }[]

  for (const { repo, cwd } of rows) {
    /**
     * Cut at a whole PATH COMPONENT, never at a string prefix.
     *
     * `/${repo}` matches inside `/Projects/application-1/src` and would seed the
     * path `/Projects/application`, a directory that need not exist — after which
     * every run from the real checkout resolves to no project at all. The
     * numbered clones on the other machine make that the common case rather
     * than a corner one.
     */
    const parts = cwd.split('/')
    const at = parts.indexOf(repo)
    const path = at === -1 ? cwd : parts.slice(0, at + 1).join('/')
    try {
      d.query(
        `INSERT INTO project (name, path, stack, canon, settings) VALUES (?,?,?,1,'{}')
         ON CONFLICT(name) DO NOTHING`,
      ).run(repo, path, null)
    } catch { /* a malformed row must not stop the rest seeding */ }
  }
}

/**
 * Let `status` hold 'blocked', on a database created before that existed.
 *
 * The CHECK is baked into the table definition and SQLite can only change one
 * by rebuilding, which db.ts has until now deliberately refused to do: the
 * comment beside the status column says a rebuild would have to drop the
 * foreign key and put every score at risk to close a hole run() never actually
 * fell through. That reasoning was right while the change bought nothing. It
 * buys something now — without it, the first worker to stop and ask a design
 * question dies on a constraint violation, and the escalation channel is
 * unusable on the only database that has any history in it.
 *
 * THE DDL IS EDITED, NOT RETYPED. The new table comes from the existing
 * `sqlite_master.sql` with one substring replaced, so every column, default and
 * constraint that has accumulated since — thirteen of them added by addColumn —
 * survives exactly as it was. Retyping the definition here would silently drop
 * whichever column somebody forgets, and the copy would still succeed.
 *
 * The same shape as migrateScoreToMatrix, which did this once already and is
 * the reason it is known to work: foreign keys off, one exclusive transaction,
 * ids preserved so `score.run_id` still points where it did.
 */
/**
 * A second widening, for the rename from `blocked` to `asking`.
 *
 * `blocked` was the wrong word and it collided with the `blocker` table,
 * which means something close to the opposite: a blocker is an ENVIRONMENT
 * problem stopping work, while this status is a worker doing exactly what it
 * was asked to — stopping to get a decision it was told not to make alone. On
 * a dashboard the two read as the same kind of red, and one of them is
 * healthy.
 *
 * The old value stays legal so a database mid-upgrade is never invalid, and
 * existing rows are renamed below.
 */
function normalizeSql(sql: string): string {
  return sql
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"|`([A-Za-z_][A-Za-z0-9_]*)`|\[([A-Za-z_][A-Za-z0-9_]*)\]/g,
      (_match, quoted: string | undefined, backticked: string | undefined,
        bracketed: string | undefined) => quoted ?? backticked ?? bracketed ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function schemaVersion(): string {
  return createHash('sha256')
    .update([RUN_DDL, SCORE_DDL, DOC_DDL, DOC_REVISION_DDL, CANON_PACK_DDL, CANON_EVAL_DDL,
      RUN_MUTATION_AUDIT_DDL,
      REVIEW_LENS_DDL, REVIEW_FINDING_DDL, LANDING_OVERRIDE_DDL, LANDING_REVIEW_CARRY_DDL]
      .map(normalizeSql).join('\n'))
    .digest('hex')
}

/** Read-only equivalent of ensureCanonicalSchema: report drift without repairing it. */
function canonicalSchemaMismatch(d: Database): boolean {
  try {
    const stored = d.query(
      `SELECT value FROM schema_meta WHERE key = 'schema'`,
    ).get() as { value: string } | null
    return stored?.value !== schemaVersion()
  } catch {
    return true
  }
}

function liveTableSql(d: Database, name: string): string | null {
  const row = d.query(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(name) as { sql: string } | null
  return row?.sql ?? null
}

function foreignKeysOn(d: Database): boolean {
  const row = d.query('PRAGMA foreign_keys').get() as { foreign_keys: number } | null
  return (row?.foreign_keys ?? 0) !== 0
}

function ensureCanonicalSchema(d: Database) {
  const current = schemaVersion()
  const stored = d.query(
    `SELECT value FROM schema_meta WHERE key = 'schema'`,
  ).get() as { value: string } | null
  if (stored?.value === current) {
    d.exec("CREATE UNIQUE INDEX IF NOT EXISTS canon_pack_address ON canon_pack(job, COALESCE(project, ''))")
    return
  }

  for (const [name, ddl] of [
    ['run', RUN_DDL], ['score', SCORE_DDL], ['doc', DOC_DDL], ['doc_revision', DOC_REVISION_DDL],
    ['canon_pack', CANON_PACK_DDL], ['canon_eval', CANON_EVAL_DDL],
    ['run_mutation_audit', RUN_MUTATION_AUDIT_DDL], ['review_lens', REVIEW_LENS_DDL],
    ['review_finding', REVIEW_FINDING_DDL],
    ['landing_override', LANDING_OVERRIDE_DDL],
    ['landing_review_carry', LANDING_REVIEW_CARRY_DDL],
  ] as const) {
    const live = liveTableSql(d, name)
    if (!live) continue
    if (normalizeSql(live) === normalizeSql(ddl)) continue
    rebuildTable(d, name, ddl)
  }

  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS canon_pack_address ON canon_pack(job, COALESCE(project, ''))")

  d.query(
    `INSERT INTO schema_meta (key, value) VALUES ('schema', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(current)
}

/**
 * Rebuild `run` with one substring of its own DDL replaced.
 *
 * Shared by both widenings, because the risky part is identical and a second
 * copy of it is a second chance to get the foreign key or the column list
 * wrong. The DDL is EDITED rather than retyped so every column that has
 * accumulated survives exactly as it was.
 */
function rebuildTable(
  d: Database,
  table: 'run' | 'score' | 'doc' | 'doc_revision' | 'canon_pack' | 'canon_eval' |
    'run_mutation_audit' | 'review_lens' |
    'review_finding' | 'landing_override' | 'landing_review_carry',
  canonical: string,
) {
  const fkOn = foreignKeysOn(d)
  d.exec('PRAGMA foreign_keys = OFF')
  d.exec('BEGIN EXCLUSIVE')
  try {
    // The stored DDL is whatever SQLite recorded, which here is
    // `CREATE TABLE IF NOT EXISTS "run" (` — quoted, and with the IF NOT
    // EXISTS that migrate() wrote. Matching the leading clause with a pattern
    // rather than a literal is what makes this survive all four spellings.
    const newName = `${table}_new`
    const ddl = canonical.replace(
      /^\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["'`\[]?\w+["'`\]]?/i,
      `CREATE TABLE ${newName}`,
    )
    if (!ddl.startsWith(`CREATE TABLE ${newName}`)) {
      throw new Error(`could not rename the ${table} table in its own DDL: ${canonical.slice(0, 80)}`)
    }
    d.exec(ddl)
    const oldCols = new Set(
      (d.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    )
    const newCols = (d.query(`PRAGMA table_info(${newName})`).all() as { name: string }[])
      .map((c) => c.name)
    const newColSet = new Set(newCols)
    const dropped = [...oldCols].filter((c) => !newColSet.has(c))
    if (dropped.length) {
      throw new Error(
        `live column(s) ${dropped.join(', ')} would be dropped by a rebuild; ` +
        'this binary is older than the store',
      )
    }
    const common = newCols.filter((c) => oldCols.has(c))
    const insertList = common.map((c) => `"${c}"`).join(', ')
    const selectList = common.map((c) => {
      if (table === 'run' && c === 'status') {
        return `CASE WHEN "status" = 'blocked' THEN 'asking' ELSE "status" END`
      }
      return `"${c}"`
    }).join(', ')
    if (table !== 'canon_pack' || oldCols.has('job')) {
      d.exec(`INSERT INTO ${newName} (${insertList}) SELECT ${selectList} FROM ${table}`)
    }
    const oldSequence = (() => {
      try {
        return (d.query('SELECT seq FROM sqlite_sequence WHERE name=?').get(table) as
          { seq: number } | null)?.seq ?? null
      } catch { return null }
    })()
    d.exec(`DROP TABLE ${table}`)
    d.exec(`ALTER TABLE ${newName} RENAME TO ${table}`)
    if (oldSequence !== null && newColSet.has('id')) {
      const maxId = (d.query(`SELECT MAX(id) AS id FROM ${table}`).get() as
        { id: number | null }).id ?? 0
      const sequence = Math.max(oldSequence, maxId)
      const restored = d.query('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(sequence, table)
      if (restored.changes === 0) {
        d.query('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, sequence)
      }
    }
    if (table === 'run') {
      d.exec('CREATE INDEX IF NOT EXISTS run_job_agent ON run(job, agent)')
    } else if (table === 'canon_pack') {
      d.exec("CREATE UNIQUE INDEX IF NOT EXISTS canon_pack_address ON canon_pack(job, COALESCE(project, ''))")
    } else if (table === 'score') {
      d.exec(`
        CREATE INDEX IF NOT EXISTS score_run ON score(run_id);
        CREATE UNIQUE INDEX IF NOT EXISTS score_one_per_run ON score(run_id);
      `)
    } else if (table === 'doc') {
      d.exec(`
        CREATE INDEX IF NOT EXISTS doc_scope_subject ON doc(scope, subject);
        CREATE UNIQUE INDEX IF NOT EXISTS doc_address ON doc(scope, COALESCE(subject, ''), slug);
      `)
    } else if (table === 'doc_revision') {
      d.exec(`
        CREATE INDEX IF NOT EXISTS doc_revision_doc ON doc_revision(doc_id, id);
        CREATE INDEX IF NOT EXISTS doc_revision_address ON doc_revision(scope, subject, slug, id);
      `)
    } else if (table === 'review_lens') {
      d.exec('CREATE INDEX IF NOT EXISTS review_calibration ON review_lens(lens, agent, model, review_id)')
    } else if (table === 'run_mutation_audit') {
      d.exec('CREATE INDEX IF NOT EXISTS run_mutation_audit_root ON run_mutation_audit(root_id)')
    }
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  } finally {
    if (fkOn) d.exec('PRAGMA foreign_keys = ON')
  }
}

/**
 * A run is one delegated call. A score is a judgment about it, recorded
 * separately because the judgment usually arrives after the caller has read
 * the output — and a run nobody judged must stay distinguishable from one
 * judged poorly.
 *
 * Canonical DDL, stored without IF NOT EXISTS so sqlite_master on a fresh
 * database matches it (SQLite strips IF NOT EXISTS from the recorded sql).
 */
const RUN_DDL = `CREATE TABLE run (
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
      schema_path   TEXT,
      docs_injected INTEGER,
      doc_revisions TEXT,
      canon_sha     TEXT
    )`

const REVIEW_LENS_DDL = `CREATE TABLE review_lens (
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
      reproduced TEXT CHECK (reproduced IS NULL OR reproduced IN (${sqlValues(REVIEW_REPRODUCED)})),
      coverage TEXT CHECK (coverage IS NULL OR coverage IN (${sqlValues(REVIEW_COVERAGE)})),
      limits TEXT CHECK (limits IS NULL OR limits IN (${sqlValues(REVIEW_LIMITS)})),
      overlap TEXT CHECK (overlap IS NULL OR overlap IN (${sqlValues(REVIEW_OVERLAP)}))
    )`

const REVIEW_FINDING_DDL = `CREATE TABLE review_finding (
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
      triaged_severity TEXT CHECK (triaged_severity IS NULL OR triaged_severity IN (${sqlValues(REVIEW_SEVERITY)})),
      triaged_at TEXT,
      UNIQUE(review_id, ordinal),
      CHECK (disposition = 'rejected' OR rejection_category IS NULL)
    )`

const LANDING_OVERRIDE_DDL = `CREATE TABLE landing_override (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      branch TEXT NOT NULL,
      tip TEXT NOT NULL,
      tree TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      session_id TEXT,
      at TEXT NOT NULL
    )`

const LANDING_REVIEW_CARRY_DDL = `CREATE TABLE landing_review_carry (
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
    )`

// A judgement has two axes, because the two ways a run disappoints you are
// fixed by opposite things.
//
// DELIVERY is plumbing: did an answer arrive at all. When it did not, the
// remedy is a bigger context window, a capability the agent lacks, a
// sandbox that stopped denying it — or not sending that agent this job.
// QUALITY is judgement: given that something arrived, was it right. The
// remedy there is a smarter agent, and nothing else.
//
// One ordinal column could not tell them apart, so it did not: run 279 came
// back as 57 bytes of vendor error and was recorded 'bad', indistinguishable
// from a full answer that was simply wrong. 'unusable' existed for exactly
// this and was offered nowhere anyone was actually scoring, so it was used
// once in 58 judgements.
const SCORE_DDL = `CREATE TABLE score (
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
    )`

const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',')
const DOC_SCOPE_SQL = sqlList(DOC_SCOPES)
const DOC_SUBJECT_SCOPE_SQL = sqlList(
  DOC_SCOPES.filter((scope) => DOC_SCOPE_SUBJECT_KIND[scope] !== null),
)
const DOC_SUBJECTLESS_SCOPE_SQL = sqlList(
  DOC_SCOPES.filter((scope) => DOC_SCOPE_SUBJECT_KIND[scope] === null),
)

const DOC_DDL = `CREATE TABLE doc (
      id         INTEGER PRIMARY KEY,
      scope      TEXT NOT NULL CHECK (scope IN (${DOC_SCOPE_SQL})),
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
      CHECK ((scope IN (${DOC_SUBJECTLESS_SCOPE_SQL}) AND subject IS NULL) OR
             (scope IN (${DOC_SUBJECT_SCOPE_SQL}) AND subject IS NOT NULL)),
      UNIQUE(scope, subject, slug)
    )`

const CANON_PACK_DDL = `CREATE TABLE canon_pack (
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
    )`

const CANON_EVAL_DDL = `CREATE TABLE canon_eval (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT NOT NULL,
      run_id     INTEGER NOT NULL REFERENCES run(id),
      canon_sha  TEXT NOT NULL,
      agent      TEXT NOT NULL,
      model      TEXT,
      pass       INTEGER NOT NULL,
      why        TEXT NOT NULL,
      at         TEXT NOT NULL
    )`

const RUN_MUTATION_AUDIT_DDL = `CREATE TABLE run_mutation_audit (
      run_id       INTEGER NOT NULL REFERENCES run(id),
      root_id      INTEGER NOT NULL REFERENCES run(id),
      action       TEXT NOT NULL CHECK (action IN (${RUN_MUTATION_ACTION_SQL})),
      actor_session TEXT CHECK (actor_session IS NULL OR length(actor_session) > 0),
      at           TEXT NOT NULL,
      reason       TEXT
    )`

const DOC_REVISION_DDL = `CREATE TABLE doc_revision (
      id         INTEGER PRIMARY KEY,
      doc_id     INTEGER NOT NULL,
      scope      TEXT NOT NULL CHECK (scope IN (${DOC_SCOPE_SQL})),
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
      CHECK ((scope IN (${DOC_SUBJECTLESS_SCOPE_SQL}) AND subject IS NULL) OR
             (scope IN (${DOC_SUBJECT_SCOPE_SQL}) AND subject IS NOT NULL))
    )`

function createIfNotExists(ddl: string): string {
  return ddl.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ')
}

function migrate(d: Database) {
  d.exec(createIfNotExists(RUN_DDL))
  d.exec(createIfNotExists(SCORE_DDL))
  d.exec(createIfNotExists(DOC_DDL))
  d.exec(createIfNotExists(DOC_REVISION_DDL))
  d.exec(createIfNotExists(CANON_PACK_DDL))
  d.exec(createIfNotExists(CANON_EVAL_DDL))
  d.exec(createIfNotExists(RUN_MUTATION_AUDIT_DDL))
  d.exec(createIfNotExists(LANDING_OVERRIDE_DDL))
  d.exec(createIfNotExists(LANDING_REVIEW_CARRY_DDL))
  d.exec(`
    -- The ratio this whole layer exists to move: Claude tokens spent per unit of
    -- shipped work. Kept as daily rows because the trend is what matters — the
    -- absolute number rests on a rough denominator (a one-commit task and a
    -- forty-commit task count the same).
    CREATE TABLE IF NOT EXISTS metric (
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
    CREATE INDEX IF NOT EXISTS run_job_agent ON run(job, agent);
    -- Written by the block-agent hook, not by orch itself: every Claude
    -- subagent spawn, allowed or denied. Subagents are ~18% of Claude spend
    -- here, and a gate that cannot report what it let through cannot be tuned.
    CREATE TABLE IF NOT EXISTS spawn (
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
    CREATE INDEX IF NOT EXISTS spawn_at ON spawn(at);
    -- One cheap write per CLI invocation says the session itself was recently
    -- present. Worker pids cannot say that: asking workers exit by design.
    CREATE TABLE IF NOT EXISTS session_seen (
      session_id TEXT PRIMARY KEY,
      last_seen  TEXT NOT NULL
    );
    -- Append-only provenance for state changes to a run chain. The action
    -- vocabulary is generated from RUN_MUTATION_ACTIONS above, so storage and
    -- display cannot silently disagree about which events exist.
    CREATE INDEX IF NOT EXISTS run_mutation_audit_root
      ON run_mutation_audit(root_id);
    CREATE INDEX IF NOT EXISTS score_run ON score(run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS score_one_per_run ON score(run_id);
    CREATE INDEX IF NOT EXISTS doc_scope_subject ON doc(scope, subject);
    CREATE INDEX IF NOT EXISTS doc_revision_doc ON doc_revision(doc_id, id);
    CREATE INDEX IF NOT EXISTS doc_revision_address ON doc_revision(scope, subject, slug, id);
  `)

  const duplicateAddresses = d.query(
    `SELECT scope, subject, slug, group_concat(id, ',') AS ids
       FROM doc GROUP BY scope, COALESCE(subject, ''), slug HAVING COUNT(*) > 1`,
  ).all() as { scope: string; subject: string | null; slug: string; ids: string }[]
  if (duplicateAddresses.length) {
    const duplicate = duplicateAddresses[0]!
    throw new Error(
      `duplicate doc address ${duplicate.scope}/${duplicate.subject ?? '_'}/${duplicate.slug}; ` +
      `conflicting doc ids: ${duplicate.ids}`,
    )
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS doc_address ON doc(scope, COALESCE(subject, ''), slug)")
  d.query(
    `INSERT INTO doc_revision
       (doc_id, scope, subject, slug, op, title, body, author, reason, session_id, at)
     SELECT d.id, d.scope, d.subject, d.slug, 'backfill', d.title, d.body,
            'migration', 'state at DEV-256 migration', NULL, d.updated_at
       FROM doc d
      WHERE NOT EXISTS (SELECT 1 FROM doc_revision r WHERE r.doc_id = d.id)`,
  ).run()

  d.exec(`
    -- A relative judgement between two outputs from the same fan-out.
    CREATE TABLE IF NOT EXISTS duel (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      job           TEXT NOT NULL,
      winner_run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      loser_run_id  INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      session_id    TEXT,
      at            TEXT NOT NULL,
      CHECK (winner_run_id <> loser_run_id),
      UNIQUE (winner_run_id, loser_run_id)
    );
    CREATE INDEX IF NOT EXISTS duel_job ON duel(job);

    -- A second reading of an old score, kept apart so measuring the scorer can
    -- never rewrite the verdict the router actually learned from.
    CREATE TABLE IF NOT EXISTS calibration (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      delivery   TEXT NOT NULL CHECK (delivery IN ('none','partial','full')),
      quality    TEXT CHECK (quality IN ('wrong','mixed','right')),
      fidelity   TEXT CHECK (fidelity IS NULL OR fidelity IN ('drifted','partial','faithful')),
      at         TEXT NOT NULL,
      session_id TEXT,
      CHECK ((delivery = 'none') = (quality IS NULL))
    );

    -- A design decision a worker refused to make on its own.
    --
    -- This table is the entire reason implementation can be delegated at all.
    -- The standing objection to fanning out implementation is that parallel
    -- workers make conflicting IMPLICIT decisions; the word doing the work
    -- there is 'implicit'. A question recorded here is a decision that has been
    -- made explicit and routed to the one place holding the whole design, which
    -- is what turns "several agents guessing" into "several agents building to
    -- one architect's rulings".
    CREATE TABLE IF NOT EXISTS question (
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
    -- The projects this machine works on, as data rather than as code.
    --
    -- Everything here used to know four repository names and one person's home
    -- directory. That is not wrong for one machine and makes the tool unusable
    -- by anyone else: you cannot adopt a router whose notion of "a project" is
    -- somebody else's filesystem.
    CREATE TABLE IF NOT EXISTS project (
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
    -- WHAT STOPPED A WORKER VERIFYING ITS WORK.
    --
    -- Separate from the question table, because they are answered by different
    -- people:
    -- a question needs the architect and the worker waits; a blocker needs the
    -- ENVIRONMENT and the worker carries on without it. A blocker therefore
    -- arrives alongside a COMPLETED run, which is exactly why nothing was
    -- catching them — the run looked fine.
    --
    -- Four review runs in one session reported, in prose nobody could query,
    -- that they could not run anything: a denied Docker socket, no PHP on the
    -- host, a missing native binding. One downgraded its whole test verdict to
    -- static review because of it. A blocker capping every review on this
    -- machine looked identical to no blocker at all.
    CREATE TABLE IF NOT EXISTS blocker (
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
    CREATE INDEX IF NOT EXISTS blocker_run ON blocker(run_id);
    CREATE INDEX IF NOT EXISTS blocker_kind ON blocker(kind, at);
    CREATE INDEX IF NOT EXISTS question_run ON question(run_id);
    CREATE TABLE IF NOT EXISTS review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at TEXT NOT NULL,
      completed_at TEXT,
      tier INTEGER,
      tier_risk INTEGER,
      tier_size INTEGER,
      tier_reasons TEXT,
      tier_reason TEXT
    );
    ${createIfNotExists(REVIEW_LENS_DDL)};
    ${createIfNotExists(REVIEW_FINDING_DDL)};
    CREATE INDEX IF NOT EXISTS review_calibration ON review_lens(lens, agent, model, review_id);
    -- Open questions, which is the only query the inbox actually runs.
    CREATE INDEX IF NOT EXISTS question_open ON question(answered_at) WHERE answered_at IS NULL;
    -- Non-authoritative context exchanged while a worker is still running.
    -- One table serves both directions so a run's complete conversation is
    -- ordered by one clock and one id. read_at is the receipt: NULL means only
    -- queued, never delivered.
    CREATE TABLE IF NOT EXISTS run_message (
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
    CREATE INDEX IF NOT EXISTS run_message_root ON run_message(root_run_id, id);
    CREATE INDEX IF NOT EXISTS run_message_unread
      ON run_message(root_run_id, direction, read_at) WHERE read_at IS NULL;
    -- One monitor pass is durable even when it finds nothing: empty passes are
    -- the denominator needed to decide whether its provisional schedule is too
    -- eager. Conditions retain their observed age rather than asking a later
    -- query to reconstruct it from mutable state.
    CREATE TABLE IF NOT EXISTS monitor_invocation (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      trigger     TEXT NOT NULL CHECK (trigger IN ('invoked','backstop')),
      findings    INTEGER,
      errors      INTEGER
    );
    CREATE TABLE IF NOT EXISTS monitor_condition (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      invocation_id   INTEGER NOT NULL REFERENCES monitor_invocation(id) ON DELETE CASCADE,
      kind             TEXT NOT NULL,
      subject          TEXT NOT NULL,
      condition_since  TEXT,
      age_ms           INTEGER,
      detail           TEXT NOT NULL,
      action           TEXT NOT NULL,
      issue_key        TEXT,
      severity         TEXT CHECK (severity IS NULL OR severity IN (${sqlValues(MONITOR_SEVERITY)})),
      UNIQUE(invocation_id, kind, subject)
    );
    CREATE INDEX IF NOT EXISTS monitor_condition_kind
      ON monitor_condition(kind, invocation_id);
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  migratePortSchema(d)
  migrateWorkflowSchema(d)

  migrateScoreToMatrix(d)
  addColumn(d, 'run_message', 'read_by', 'TEXT')
  addColumn(d, 'score', 'fidelity', 'TEXT')

  // The status DEFAULT and CHECK above apply to databases created from here on.
  // An existing one keeps the old `DEFAULT 'ok'` and no CHECK: SQLite can only
  // change either by rebuilding the table, and `score.run_id` cascades on
  // delete, so a rebuild would have to drop the foreign key and put every score
  // at risk to close a hole that run() has never actually fallen through — it
  // has always passed status explicitly. Not worth the trade on a live file.

  // Added after the table shipped, so existing databases need them grafted on.
  addColumn(d, 'run', 'vendor_cost_usd', 'REAL')
  addColumn(d, 'run', 'probe', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(d, 'run', 'failure_kind', 'TEXT')
  for (const [c, decl] of [
    ['canon_tokens', 'INTEGER NOT NULL DEFAULT 0'], ['other_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['commits', 'INTEGER NOT NULL DEFAULT 0'], ['files', 'INTEGER NOT NULL DEFAULT 0'],
    ['lines_product', 'INTEGER NOT NULL DEFAULT 0'], ['lines_test', 'INTEGER NOT NULL DEFAULT 0'],
    ['lines_docs', 'INTEGER NOT NULL DEFAULT 0'], ['lines_config', 'INTEGER NOT NULL DEFAULT 0'],
    ['lines_generated', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const) addColumn(d, 'metric', c, decl)
}

const WORKFLOW_DDL = `
    -- Identity only. Title and steps live in the versioned definition so replacing
    -- production does not rewrite the slug.
    CREATE TABLE IF NOT EXISTS workflow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    -- Immutable definition snapshot. n/definition/author/reason/created_at are
    -- write-once; status/promoted_at/retired_at are the current-state index so
    -- the unique production row can be constrained here. Provenance of those
    -- transitions is workflow_event, not an overwrite of author/reason.
    CREATE TABLE IF NOT EXISTS workflow_version (
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
    CREATE UNIQUE INDEX IF NOT EXISTS workflow_one_production
      ON workflow_version(workflow_id) WHERE status = 'production';
    -- Append-only transitions. One version may be set, then promoted, then retired.
    CREATE TABLE IF NOT EXISTS workflow_event (
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
    CREATE INDEX IF NOT EXISTS workflow_version_workflow ON workflow_version(workflow_id, n);
    CREATE INDEX IF NOT EXISTS workflow_event_version ON workflow_event(workflow_id, version_n, id);
  `

function migrateWorkflowSchema(d: Database): void {
  d.exec(WORKFLOW_DDL)
  seedWorkflows(d)
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
 * Replace the abandoned port tables with the schema the feature actually uses.
 *
 * Those tables were never created by this file and no released code used them.
 * The one database carrying them has no rows, so preserving their defective
 * shapes would only make that database differ from a fresh installation.  Do
 * still refuse to discard rows: an unexpectedly populated copy needs a
 * deliberate data migration, not an automatic best guess.
 */
function migratePortSchema(d: Database) {
  const legacy = (d.query(`PRAGMA table_info(port_ref)`).all() as { name: string }[])
    .some((column) => column.name === 'source_projects')

  if (legacy) {
    for (const table of ['port_doctrine', 'port_ref', 'port_baseline', 'port_skipped']) {
      const row = d.query(
        `SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?`,
      ).get(table)
      if (!row) continue
      const count = d.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      if (count.n !== 0) {
        throw new Error(`cannot replace populated legacy ${table} table`)
      }
    }
    d.exec(`
      DROP TABLE IF EXISTS port_doctrine;
      DROP TABLE IF EXISTS port_ref;
      DROP TABLE IF EXISTS port_baseline;
      DROP TABLE IF EXISTS port_skipped;
    `)
  }

  d.exec(`
    -- A directed source -> target relationship is the unit of scan progress.
    -- Register ids survive renames; RESTRICT prevents removing a project while
    -- feature state still depends on it.
    CREATE TABLE IF NOT EXISTS port_pair (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      source_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
      target_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
      created_at        TEXT NOT NULL,
      CHECK (source_project_id <> target_project_id),
      UNIQUE (source_project_id, target_project_id)
    );
    CREATE INDEX IF NOT EXISTS port_pair_target ON port_pair(target_project_id);

    CREATE TABLE IF NOT EXISTS port_baseline (
      pair_id       INTEGER PRIMARY KEY REFERENCES port_pair(id) ON DELETE CASCADE,
      source_commit TEXT,
      scanned_at    TEXT,
      CHECK ((source_commit IS NULL) = (scanned_at IS NULL))
    );

    CREATE TABLE IF NOT EXISTS port_skip (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pair_id    INTEGER NOT NULL REFERENCES port_pair(id) ON DELETE CASCADE,
      candidate  TEXT NOT NULL,
      reason     TEXT NOT NULL,
      skipped_at TEXT NOT NULL,
      UNIQUE (pair_id, candidate)
    );
    CREATE INDEX IF NOT EXISTS port_skip_pair ON port_skip(pair_id);

    -- The target task owns the ledger entry. Source material is normalized
    -- below it so several source projects never collapse into one JSON field.
    CREATE TABLE IF NOT EXISTS port_ref (
      task_key          TEXT PRIMARY KEY,
      target_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
      note              TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      resolved_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS port_ref_target ON port_ref(target_project_id);

    CREATE TABLE IF NOT EXISTS port_ref_source (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key          TEXT NOT NULL REFERENCES port_ref(task_key) ON DELETE CASCADE,
      source_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
      commits           TEXT NOT NULL,
      paths             TEXT NOT NULL,
      note              TEXT NOT NULL,
      UNIQUE (task_key, source_project_id)
    );
    CREATE INDEX IF NOT EXISTS port_ref_source_task ON port_ref_source(task_key);

    CREATE TABLE IF NOT EXISTS port_doctrine (
      number     INTEGER PRIMARY KEY CHECK (number > 0),
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      retired_at TEXT
    );
  `)
}

/**
 * Move a single-verdict score table onto the two axes.
 *
 * Runs once, on a database that still has the `verdict` column. The mapping is
 * mechanical and preserves every weight exactly (see WEIGHT), so no agent's
 * standing moves as a result of the migration itself.
 *
 * `unusable` becomes a delivery failure, which is what it always meant. The one
 * thing that is NOT mechanical: a `bad` verdict whose own note says nothing came
 * back is a delivery failure that had nowhere else to go, because the only
 * vocabulary offered at the point of scoring was good/partial/bad. Those are
 * corrected from the note rather than migrated as quality judgements, and the
 * test for it is deliberately narrow — the note has to say so in as many words.
 * Anything an existing note does not settle is left alone, and was reviewed by
 * hand: run 264 moved to partial/right on the strength of its own note, and run
 * 3 was left for the author to judge. There is no command for this — it was a
 * one-time migration, and inventing a subcommand to justify a sentence would be
 * the wrong way round.
 */
function migrateScoreToMatrix(d: Database) {
  const cols = d.query(`PRAGMA table_info(score)`).all() as { name: string }[]
  if (!cols.some((c) => c.name === 'verdict')) return  // already migrated
  if (cols.some((c) => c.name === 'delivery')) return  // half-done; leave it alone

  d.exec('PRAGMA foreign_keys = OFF')
  d.exec('BEGIN EXCLUSIVE')
  try {
    d.exec(`
      CREATE TABLE score_new (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id    INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
        delivery  TEXT NOT NULL CHECK (delivery IN ('none','partial','full')),
        quality   TEXT CHECK (quality IN ('wrong','mixed','right')),
        note      TEXT,
        scored_at TEXT NOT NULL,
        scored_by TEXT NOT NULL DEFAULT 'claude',
        CHECK ((delivery = 'none') = (quality IS NULL))
      );
      INSERT INTO score_new (id, run_id, delivery, quality, note, scored_at, scored_by)
      SELECT id, run_id,
             CASE
               WHEN verdict = 'unusable' THEN 'none'
               -- A verdict whose note says nothing came back. Narrow on purpose.
               WHEN note LIKE '%nothing usable%'
                 OR note LIKE '%zero output%'
                 OR note LIKE '%no findings at all%' THEN 'none'
               ELSE 'full'
             END,
             CASE
               WHEN verdict = 'unusable' THEN NULL
               WHEN note LIKE '%nothing usable%'
                 OR note LIKE '%zero output%'
                 OR note LIKE '%no findings at all%' THEN NULL
               WHEN verdict = 'good'    THEN 'right'
               WHEN verdict = 'partial' THEN 'mixed'
               ELSE 'wrong'
             END,
             note, scored_at, scored_by
      FROM score;
      DROP TABLE score;
    `)
    d.exec('ALTER TABLE score_new RENAME TO score')
    d.exec(`
      CREATE INDEX IF NOT EXISTS score_run ON score(run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS score_one_per_run ON score(run_id);
    `)
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  } finally {
    d.exec('PRAGMA foreign_keys = ON')
  }
}

/** Columns added after the first schema shipped; SQLite has no IF NOT EXISTS for these. */
function addColumn(d: Database, table: string, col: string, decl: string) {
  const cols = d.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
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
 * be undone by a worker finishing concurrently.
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
        AND root.status NOT IN ('stopped', 'stale')
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
 * corpus is under a hundred judgements and five decide a route.
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
  // An unknown level is not a zero penalty. `fidelity` is CHECK-constrained on
  // a fresh database but was grafted onto existing ones with addColumn, which
  // cannot carry a constraint — so a typo reaches here, and reading it as
  // "no penalty" would quietly flatter a run nobody judged.
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

/** Record one winner against every named loser after validating the comparison. */
export function recordDuels(
  winnerRunId: number,
  loserRunIds: number[],
  callerSession: string | null,
  at: string,
  force = false,
): void {
  writableDb()
  const ids = [winnerRunId, ...loserRunIds]
  const rows = db().query(
    `SELECT id, job, session_id FROM run WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as { id: number; job: string; session_id: string | null }[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of ids) {
    if (!byId.has(id)) throw new Error(`no run ${id}`)
  }
  const winner = byId.get(winnerRunId)!
  for (const loserId of loserRunIds) {
    if (loserId === winnerRunId) {
      throw new Error(`run ${winnerRunId} cannot be better than itself`)
    }
    const loser = byId.get(loserId)!
    if (loser.job !== winner.job) {
      throw new Error(
        `runs ${winnerRunId} and ${loserId} cannot be compared: ` +
        `jobs differ (${winner.job} and ${loser.job})`,
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
  const insert = db().query(
    `INSERT INTO duel (job, winner_run_id, loser_run_id, session_id, at)
     VALUES (?,?,?,?,?) ON CONFLICT(winner_run_id, loser_run_id) DO NOTHING`,
  )
  writeTransaction(() => {
    for (const loserId of loserRunIds) {
      insert.run(winner.job, winnerRunId, loserId, callerSession, at)
    }
  })
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
