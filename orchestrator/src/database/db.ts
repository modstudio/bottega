// concern: database
/** Knows store location, connection authority, schema lifecycle, transactions, and fixture seeding. Must not know worktrees, runs, routing, reviews, contracts, transports, CLI adapters, or Docker resources. */
import { constants, Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  existsSync,
  constants as fileConstants,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { storedMachineId } from '../../../shared/machine-config.ts'
import { pidAlive } from '../../../shared/process-identity.ts'
import { createReadOnlyDatabaseAccess } from '../../../shared/read-only-database-access.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { decideStoreAccess } from '../../../shared/store-access.ts'
import {
  type CallerIdentityResolution,
  classifyCaller,
  resolveCallerIdentity,
} from '../caller-classification.ts'
import { contentionTableExists, insertContention } from './contention.ts'
import { DATABASE_SIDECAR_SUFFIXES } from './database-file-family.ts'
import {
  DATABASE_RESOLUTION,
  DB_PATH,
  existingDatabaseMigrationRefusal,
  implicitDatabaseCreationRefusal,
  legacyDatabaseRefusal,
  linkedWorktreeDatabaseInitializationMessage,
  linkedWorktreeMigrationAllowed,
  missingDatabaseMessage,
} from './database-location.ts'
import { carryMachineIdentity } from './machine-identity-store.ts'
import {
  decideInFlightMigration,
  inFlightMigrationCompatibility,
} from './migration-compatibility.ts'
import {
  applyMigrations,
  applyMigrationsBefore,
  type BeforeMigrationApply,
  migrationJournal,
  migrationRefusal,
  readUserVersion,
  staleWriteRefusal,
} from './migrations.ts'
import { initializeDefaultLocalProject } from './project-register-store.ts'
import {
  LINKED_WORKTREE_WRITE_REFUSAL,
  persistentReadOnlyRefusal,
  readerOpenMode,
  restrictedStoreActor,
  type StoreActorFacts,
  storeWriteRefusal,
} from './store-actor.ts'
import {
  isWriteProbeTable,
  staleWriteProbe,
  WRITE_PROBE_TABLE_PREFIX,
  writeProbeOwnerPid,
} from './write-probe.ts'

export { DATABASE_RESOLUTION, DB_PATH, ROOT } from './database-location.ts'

let handle: Database | null = null
let readOnlyHandle: Database | null = null
const databaseAccess = createReadOnlyDatabaseAccess()
let connectionWritable: boolean | null = null
let openedUserVersion: number | null = null
const noopSchemaReload = (): void => {}
let schemaReload: ((from: number, to: number) => void) | null = null
let schemaReloadRefusal: ((reason: string) => void) | null = null
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
  if (!storeWritesRefused()) registeredOpenHooks()
}
function runOpenHooks(moment: keyof OpenHooks, database: Database): void {
  for (const hook of registeredOpenHooks()[moment] ?? []) hook(database)
}
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

/** The caller facts this adapter gathers once at load; the write-authority decision is pure. */
const storeActorFacts: Omit<StoreActorFacts, 'brokerChannel'> = {
  linkedWorktreeBinary: DATABASE_RESOLUTION.linkedWorktreeBinary,
  namedStoreOverride: DATABASE_RESOLUTION.method === 'BOTTEGA_ORCHESTRATOR_DB',
  namedStoreIsMainStore: sameStore(DB_PATH, DATABASE_RESOLUTION.mainStorePath),
  operatorWriteInsistence: process.env.BOTTEGA_ORCHESTRATOR_DB_WRITE === '1',
  workerCaller: classifyCaller(process.env).kind === 'worker',
}

/**
 * The worker's ask server is the one process that writes the store from a
 * worker-classified environment, because its question, message and gate rows ARE
 * the escalation channel. Its own entry point (orchestrator/src/ask) declares it
 * before it opens the store: a store opened read-only can never be written
 * through afterwards, and nothing here infers this channel from arguments or from
 * the environment.
 *
 * This restriction guards against an accidental worker write or migration — a
 * worker misreading the shared store as its own, or a schema change under a live
 * operator — and it assumes the caller does not set out to defeat it. It is not
 * the adversarial boundary; a same-uid process that detaches itself already has
 * the operator's power. The broker channel is exempt from the write refusal
 * alone: every migration entry still refuses a worker caller, this process
 * included.
 */
let storeBrokerChannel = false

export function declareStoreBrokerChannel(): void {
  storeBrokerChannel = true
}

function orchestratorStoreAccess(walOrShmSidecarPresent: boolean) {
  return decideStoreAccess({
    restrictedActor: restrictedStoreActor({
      ...storeActorFacts,
      brokerChannel: storeBrokerChannel,
    }),
    storePathUnderTemporaryRoot: linkedWorktreeMigrationAllowed(DB_PATH),
    walOrShmSidecarPresent,
  })
}

/** Whether this process may write the store, or open it for writing at all. */
export function storeWritesRefused(): boolean {
  return orchestratorStoreAccess(false).writesRefused
}

let registeredStoreWriteProtected = false

export function databaseOpenMode(): 'read-write' | 'read-only restricted caller' {
  return storeWritesRefused() ? 'read-only restricted caller' : 'read-write'
}

/**
 * Open a caller-owned connection that SQLite itself will refuse to write through.
 * Without WAL sidecars it opens immutable, so it reads the store as of the open and never sees a later writer; a short-lived check tolerates that and a long-lived reader must not use it — the process handle takes plain read-only for exactly that reason (see openPersistentReadOnlyDatabase).
 */
export function openReadOnlyDatabase(path = DB_PATH): Database {
  if (path === DB_PATH) {
    const refusal = legacyDatabaseRefusal()
    if (refusal) throw new Error(refusal)
  }
  const sidecarsExist = existsSync(`${path}-wal`) || existsSync(`${path}-shm`)
  const access = decideStoreAccess({
    restrictedActor: true,
    storePathUnderTemporaryRoot: false,
    walOrShmSidecarPresent: sidecarsExist,
  })
  return openReadOnlyStore(path, access.openMode === 'read-only-immutable')
}

/**
 * Open a store read-only; immutable when it has no WAL sidecars. The immutable form is a URI,
 * which Bun's Linux SQLite accepts only with SQLITE_OPEN_URI passed explicitly.
 */
function openReadOnlyStore(path: string, immutable: boolean): Database {
  if (!immutable) return new Database(path, { readonly: true })
  return new Database(
    `${pathToFileURL(path).href}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  )
}

/** Run one read command against a SQLite-enforced read-only process handle. */
export function withReadOnlyDatabaseAccess<T>(action: () => T): T {
  return databaseAccess.run(action)
}

/**
 * The process handle is this process's persistent reader, so it takes plain read-only: the
 * immutable snapshot (openReadOnlyStore's URI open) stays on the one-shot reader path. A
 * read-only WAL reader that cannot build its -shm sidecar opens and then fails on its first
 * read, so the reach is proved here and named in the refusal, rather than surfacing later as an
 * unexplained failure — and never by silently reading a snapshot.
 */
function openPersistentReadOnlyDatabase(path: string): Database {
  const storeDirectory = dirname(path)
  const walOrShmSidecarPresent = existsSync(`${path}-wal`) || existsSync(`${path}-shm`)
  let database: Database | null = null
  try {
    database = openReadOnlyStore(path, false)
    database.query('SELECT count(*) AS tables FROM sqlite_master').get()
    return database
  } catch (error) {
    database?.close()
    throw new Error(
      persistentReadOnlyRefusal({
        path,
        storeDirectory,
        walOrShmSidecarPresent,
        storeDirectoryWritable: storeDirectoryIsWritable(storeDirectory),
        failure: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

function storeDirectoryIsWritable(directory: string): boolean {
  try {
    accessSync(directory, fileConstants.W_OK)
    return true
  } catch {
    return false
  }
}

function commandReadOnlyDatabase(): Database {
  if (readOnlyHandle) return refuseOrReloadStaleSchema(readOnlyHandle, false)
  const legacyRefusal = legacyDatabaseRefusal()
  if (legacyRefusal) throw new Error(legacyRefusal)
  if (!existsSync(DB_PATH)) throw new Error(missingDatabaseMessage())
  readOnlyHandle = openReadOnlyDatabase()
  readOnlyHandle.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
  const refused = migrationRefusal(readOnlyHandle)
  if (refused) {
    readOnlyHandle.close()
    readOnlyHandle = null
    throw new Error(refused)
  }
  return readOnlyHandle
}

/** Request the process connection for a mutation. */
export function writableDb(): Database {
  return db(true)
}

/** Already-open writable handle, or null. Does not open a connection. */
function openWritableHandle(): Database | null {
  if (
    !handle ||
    storeWritesRefused() ||
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
  const probe = `${WRITE_PROBE_TABLE_PREFIX}${process.pid}`
  try {
    // Committing the create matters: on WAL databases SQLite can prepare a
    // write transaction against a chmod-444 main file and fail only at commit.
    d.exec('BEGIN IMMEDIATE')
    try {
      d.exec(`CREATE TABLE IF NOT EXISTS "${probe}" (value INTEGER); DROP TABLE "${probe}"; COMMIT`)
    } catch (error) {
      try {
        d.exec('ROLLBACK')
      } catch {
        /* preserve the write-probe failure */
      }
      throw error
    }
    connectionWritable = true
    try {
      sweepWriteProbes(d)
    } catch {
      /* best effort: a later process retries stale probe cleanup */
    }
  } catch {
    connectionWritable = false
  }
  return connectionWritable
}

/** Drop probe tables whose numeric owner pid is no longer alive. */
function sweepWriteProbes(d: Database): void {
  const tables = d
    .query(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND substr(name, 1, ?) = ?`,
    )
    .all(WRITE_PROBE_TABLE_PREFIX.length, WRITE_PROBE_TABLE_PREFIX) as { name: string }[]
  const stale = tables.filter(({ name }) => {
    if (!isWriteProbeTable(name)) return false
    const ownerPid = writeProbeOwnerPid(name)
    return staleWriteProbe(name, process.pid, pidAlive(ownerPid))
  })
  if (stale.length === 0) return
  d.exec('BEGIN IMMEDIATE')
  try {
    for (const { name } of stale) d.exec(`DROP TABLE "${name}"`)
    d.exec('COMMIT')
  } catch (error) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* preserve the sweep failure */
    }
    throw error
  }
}

/**
 * Fixture-only: drop the process handle so the next db() opens whatever store
 * BOTTEGA_ORCHESTRATOR_DB names afresh. The test preload mints a new store per test and never
 * clears one, which needs the cached handle released between tests.
 */
export function closeDatabaseForFixture(): void {
  handle?.close()
  readOnlyHandle?.close()
  handle = null
  readOnlyHandle = null
  connectionWritable = null
  openedUserVersion = null
  schemaReload = null
  schemaReloadRefusal = null
}

/** Flush and release the process-owned store handle before a setup state-file rename. */
export function checkpointAndCloseDatabase(): void {
  if (handle) handle.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  closeDatabaseForFixture()
}

/** Long-lived processes (bottega mcp serve) reload instead of refusing a write after a migrate. */
export function enableSchemaReload(
  onReload: (from: number, to: number) => void = noopSchemaReload,
  onRefusal?: (reason: string) => void,
): void {
  schemaReload = onReload
  schemaReloadRefusal = onRefusal ?? null
}

/**
 * Enable the exec-style reload only when this process registered none. Recording a
 * command's evidence after its child migrated the store needs a reload, but replacing
 * the registration a long-lived process already made would drop that process's own
 * reload and refusal callbacks.
 */
export function enableSchemaReloadUnlessRegistered(): void {
  if (schemaReload) return
  enableSchemaReload()
}

function refuseOrReloadStaleSchema(d: Database, forWrite: boolean): Database {
  if (handle && d !== handle) return d
  const actual = readUserVersion(d)
  const opened = openedUserVersion
  if (opened === null || actual === opened) return d
  if (schemaReload) {
    if (d.inTransaction) return d
    const from = opened
    const decision = decideInFlightMigration({
      processJournalVersion: from,
      storeVersion: actual,
      migrationCompatibility: inFlightMigrationCompatibility(migrationJournal(), from, actual),
    })
    if (decision.action === 'fail') {
      schemaReloadRefusal?.(decision.reason)
      throw new Error(decision.reason)
    }
    openedUserVersion = actual
    schemaReload(from, actual)
    return d
  }
  if (!forWrite) return d
  throw new Error(
    staleWriteRefusal(
      actual,
      opened,
      `restart this process after ${PLATFORM_SLUG} machine update (or ${PLATFORM_SLUG} machine migrate when no runs are in flight)`,
    ),
  )
}

/**
 * The schema version this process opened and the store's current one, or null when
 * this process never opened the store. A child may migrate between them, so a
 * command that runs one compares the pair after that child exits.
 */
export function storeSchemaVersions(): { opened: number; store: number } | null {
  if (openedUserVersion === null || !handle) return null
  return { opened: openedUserVersion, store: readUserVersion(handle) }
}

export function db(writable = false): Database {
  if (databaseAccess.active()) {
    if (writable) throw new Error('refusing a write from a read-only command')
    return commandReadOnlyDatabase()
  }
  return defaultDatabase(writable)
}

function defaultDatabase(writable: boolean): Database {
  if (writable && storeWritesRefused())
    throw new Error(storeWriteRefusal(storeActorFacts.workerCaller))
  if (handle) {
    if (writable && registeredStoreWriteProtected) throw new Error(LINKED_WORKTREE_WRITE_REFUSAL)
    return refuseOrReloadStaleSchema(handle, writable)
  }
  const legacyRefusal = legacyDatabaseRefusal()
  if (legacyRefusal) throw new Error(legacyRefusal)
  ensureDatabase()
  requireOpenHooksForWritableMode()
  const access = orchestratorStoreAccess(
    existsSync(`${DB_PATH}-wal`) || existsSync(`${DB_PATH}-shm`),
  )
  const openMode = readerOpenMode('persistent', access.openMode)
  const d =
    openMode === 'read-write'
      ? new Database(DB_PATH, { readwrite: true, create: false })
      : openPersistentReadOnlyDatabase(DB_PATH)
  // Several `bottega run start` processes write concurrently during a fan-out. Without a
  // busy timeout SQLite fails the moment it finds the file locked rather than
  // waiting its turn, so a parallel launch loses most of its rows — the record
  // of the very runs it was launching.
  // wal_autocheckpoint defaults to 1000 pages, roughly 4MB. Nothing here writes
  // anywhere near that in a session, so the default never fires: the log was
  // measured at 1.4MB against an 80KB database, all of it uncheckpointed. A
  // lower threshold folds pages back in as they accumulate, and the size limit
  // lets the file shrink again once a checkpoint can restart it — a long-lived
  // process holds a connection open for hours, and a long-lived reader blocks
  // truncation but not the limit taking effect afterwards.
  d.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
  const refused = migrationRefusal(d)
  if (refused) refuseOpenMigration(d, refused)
  finishDefaultDatabaseOpen(d, writable)
  return d
}

function refuseOpenMigration(d: Database, refused: string): never {
  try {
    if (contentionTableExists(d) && !storeWritesRefused()) {
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

function finishDefaultDatabaseOpen(d: Database, writable: boolean): void {
  const registered = d.query('SELECT path FROM project WHERE name = ?').get(PLATFORM_SLUG) as {
    path: string
  } | null
  DATABASE_RESOLUTION.registeredPath = registered ? DATABASE_RESOLUTION.mainStorePath : null
  registeredStoreWriteProtected = Boolean(
    DATABASE_RESOLUTION.linkedWorktreeBinary &&
      DATABASE_RESOLUTION.registeredPath &&
      sameStore(DATABASE_RESOLUTION.registeredPath, DB_PATH) &&
      process.env.BOTTEGA_ORCHESTRATOR_DB_WRITE !== '1',
  )
  if (!storeWritesRefused() && !registeredStoreWriteProtected && databaseWritable(d)) {
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

/** Mint the install identity only on a database lifecycle path already authorized to write. */
export function ensureMachineIdentity(database: Database): void {
  carryMachineIdentity(database, (fn) => writeTransaction(fn, database))
}

/** Best-effort contention insert; never throws. busyTimeoutMs 0 uses a one-shot connection. */
export function tryWriteContention(
  row: import('./contention.ts').ContentionWrite,
  opts?: { busyTimeoutMs?: number },
): void {
  try {
    if (storeWritesRefused() || registeredStoreWriteProtected) return
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

/** Ensure an ordinary store-needing command has a current, authorized store. */
export function ensureDatabase(): string {
  const legacyRefusal = legacyDatabaseRefusal()
  if (legacyRefusal) throw new Error(legacyRefusal)
  if (existsSync(DB_PATH)) return DB_PATH
  migrateDatabase()
  return DB_PATH
}

/** Explicit, idempotent alias for ensuring the orchestrator database exists. */
export function initializeDatabase(): string {
  return ensureDatabase()
}

function removeDatabaseFiles(path: string): void {
  for (const suffix of DATABASE_SIDECAR_SUFFIXES) rmSync(`${path}${suffix}`, { force: true })
}

/**
 * Build a new store under a private same-directory name, then publish its main
 * file with an atomic hard link. link(2) never replaces an existing path, so a
 * concurrent creator either publishes the whole closed store or loses without
 * gaining authority to remove the winner's files.
 */
export function createDatabasePrivately<T>(
  path: string,
  initialize: (database: Database) => T,
): { published: boolean; result: T } {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.create-${process.pid}-${randomUUID()}.tmp`
  let database: Database | null = new Database(temporary, {
    readwrite: true,
    create: true,
  })
  try {
    database.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
    const result = initialize(database)
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    database.close()
    database = null
    try {
      linkSync(temporary, path)
      return { published: true, result }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return { published: false, result }
    }
  } finally {
    try {
      database?.close()
    } finally {
      removeDatabaseFiles(temporary)
    }
  }
}

/** Seed the project register once from paths already recorded in run history. */
function seedProjects(d: Database): void {
  const { n } = d.query('SELECT COUNT(*) AS n FROM project').get() as {
    n: number
  }
  if (n > 0) return
  const rows = d
    .query(
      `SELECT repo, cwd FROM run r
      WHERE project_record_id IS NOT NULL AND cwd IS NOT NULL
        AND number = (SELECT MAX(number) FROM run x
                       WHERE x.project_record_id = r.project_record_id AND x.cwd IS NOT NULL)`,
    )
    .all() as { repo: string; cwd: string }[]
  for (const { repo, cwd } of rows) {
    const parts = cwd.split('/')
    const at = parts.indexOf(repo)
    const path = at === -1 ? cwd : parts.slice(0, at + 1).join('/')
    try {
      d.query(
        `INSERT INTO project (record_id, name, path, stack, canon, settings) VALUES (?,?,?,?,1,'{}')
         ON CONFLICT(name) DO NOTHING`,
      ).run(newRecordId(), repo, path, null)
    } catch {
      /* one malformed historical row does not block the remaining seed */
    }
  }
}

/** Main-checkout binary only: apply pending, ordered Drizzle migrations. */
export function migrateDatabase(
  input: { beforeMigration?: string; beforeApply?: BeforeMigrationApply } = {},
): {
  path: string
  versions: string[]
} {
  const legacyRefusal = legacyDatabaseRefusal()
  if (legacyRefusal) throw new Error(legacyRefusal)
  const create = !existsSync(DB_PATH)
  const creationRefusal = create
    ? implicitDatabaseCreationRefusal(DATABASE_RESOLUTION, DB_PATH, storeActorFacts.workerCaller)
    : null
  if (creationRefusal) throw new Error(creationRefusal)
  const existingRefusal = !create ? migrationAuthorityRefusal() : null
  if (existingRefusal) throw new Error(existingRefusal)
  registeredOpenHooks()
  if (create) {
    const created = createDatabasePrivately(DB_PATH, (database) => {
      const versions = input.beforeMigration
        ? applyMigrationsBefore(database, input.beforeMigration)
        : applyMigrations(database, undefined, input.beforeApply)
      writeTransaction(() => initializeDefaultLocalProject(database, true), database)
      seedProjects(database)
      // Seeding and hygiene assume the current schema, so a partial migration skips them.
      if (!input.beforeMigration) runOpenHooks('afterInitialize', database)
      return versions
    })
    if (!created.published) {
      // The winning creator published only after checkpointing and closing.
      // Opening it here makes the losing attempt observe that complete store
      // before reporting successful initialization to its caller.
      const winner = new Database(DB_PATH, { readwrite: true, create: false })
      try {
        winner.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
        const refused = migrationRefusal(winner)
        if (refused) throw new Error(refused)
      } finally {
        winner.close()
      }
    }
    return { path: DB_PATH, versions: created.result }
  }
  const d = new Database(DB_PATH, { readwrite: true, create: false })
  try {
    d.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
    const versions = input.beforeMigration
      ? applyMigrationsBefore(d, input.beforeMigration)
      : applyMigrations(d, undefined, input.beforeApply)
    writeTransaction(() => initializeDefaultLocalProject(d, false), d)
    seedProjects(d)
    if (!input.beforeMigration) runOpenHooks('afterInitialize', d)
    return { path: DB_PATH, versions }
  } finally {
    d.close()
  }
}

/**
 * The one migration authority decision for this process: the worker fact this adapter gathered
 * goes in, and the pure decision in database-location.ts names the refusal. Every migration
 * entry routes through here — the migrate command, the machine update, and the step handles
 * below — so the rule is defined once and reads one fact, gathered once.
 */
export function migrationAuthorityRefusal(): string | null {
  return existingDatabaseMigrationRefusal(DATABASE_RESOLUTION, storeActorFacts.workerCaller)
}

/** A restricted caller does not migrate the store: its schema belongs to the operator. */
function refuseStoreMigrationFromRestrictedCaller(): void {
  const refusal = migrationAuthorityRefusal()
  if (refusal) throw new Error(refusal)
}

/** Give machine migrate a handle while the store is intentionally mid-journal. */
export async function withDatabaseForMigrationStep<T>(
  action: (database: Database) => Promise<T>,
): Promise<T> {
  refuseStoreMigrationFromRestrictedCaller()
  const database = new Database(DB_PATH, { readwrite: true, create: false })
  try {
    database.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
    return await action(database)
  } finally {
    database.close()
  }
}

/** Give a synchronous migration adapter a handle while the store is intentionally mid-journal. */
export function withSynchronousDatabaseForMigrationStep<T>(action: (database: Database) => T): T {
  refuseStoreMigrationFromRestrictedCaller()
  const database = new Database(DB_PATH, { readwrite: true, create: false })
  try {
    database.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
    return action(database)
  } finally {
    database.close()
  }
}

/** One-time maintenance pass for roots whose original caller prompt remains on disk. */
export function backfillSpecSha(): { updated: number; missing: number } {
  if (DATABASE_RESOLUTION.linkedWorktreeBinary && !linkedWorktreeMigrationAllowed(DB_PATH))
    throw new Error(linkedWorktreeDatabaseInitializationMessage())
  const database = writableDb()
  const roots = database
    .query(
      `SELECT record_id, prompt_path FROM run
      WHERE parent_run_record_id IS NULL AND spec_sha IS NULL AND prompt_path IS NOT NULL`,
    )
    .all() as { record_id: string; prompt_path: string }[]
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
        .query('UPDATE run SET spec_sha=? WHERE record_id=? AND spec_sha IS NULL')
        .run(specSha, root.record_id).changes
    }
  }, database)
  return { updated, missing }
}

export const nowIso = () => new Date().toISOString()

/** Identity result of the architect or local operator making this call. */
export const callerIdentity = (database?: Database): CallerIdentityResolution => {
  const caller = classifyCaller(process.env)
  if (caller.kind !== 'operator') return resolveCallerIdentity(caller, null)
  // An absent store has no identity to read. A store that exists and refuses to open must say
  // so: swallowing that refusal would let a command report emptiness for data it never saw.
  if (!database && !existsSync(DB_PATH)) return resolveCallerIdentity(caller, null)
  return resolveCallerIdentity(caller, storedMachineId())
}

/** Identity of the architect or local operator making this call. */
export const sessionId = (database?: Database): string | null => {
  const identity = callerIdentity(database)
  return identity.kind === 'identity' ? identity.session : null
}

/**
 * A session seen inside this window is known live. A session outside it is
 * UNKNOWN, not dead: this row records orchestrator activity, not the owning process.
 * Silence therefore never transfers its authority to another session. A provably dead owner
 * process transfers authority only after every stored process not shared with the actor is gone
 * or reused and this live window has elapsed.
 */
export const SESSION_LIVE_MS = 60 * 60 * 1000

/** Stamp once at the CLI boundary; heartbeat failure must never break a read. */
export function recordSessionSeen(
  sid: string | null = sessionId(),
  at = nowIso(),
  ancestry?: { chain: unknown; confirmedAt: string },
  database?: Database,
): void {
  if (!sid) return
  const d = database ?? db()
  if (!database && !connectionWritable) return
  try {
    d.query(
      `INSERT INTO session_seen
       (session_id,last_seen,ancestor_chain,ancestor_confirmed_at) VALUES (?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_seen=excluded.last_seen,
         ancestor_chain=COALESCE(excluded.ancestor_chain,session_seen.ancestor_chain),
         ancestor_confirmed_at=COALESCE(
           excluded.ancestor_confirmed_at,
           session_seen.ancestor_confirmed_at
         )`,
    ).run(sid, at, ancestry ? JSON.stringify(ancestry.chain) : null, ancestry?.confirmedAt ?? null)
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
 * `bottega machine doctor` and the dashboard card each subtracted a total score count from
 * a total run count instead, which counts probes, in-flight runs, failures and
 * abandoned rows as debt. They reported 28 unscored where `bottega score pending` — the
 * command that actually tells you what to do about it — reported none.
 */
/**
 * `parent_run_record_id IS NULL` is what keeps a conversation one thing to judge.
 *
 * A worker that asks two questions produces three rows, and only the first is
 * the unit of work — the other two are turns inside it. Asking for a verdict on
 * each would demand three judgments for one implementation, and would let an
 * agent reach the routing threshold by being inquisitive rather than by being
 * good. The root row carries the chain's outcome (see the roll-up in run.ts
 * and rollUpRootAndEnqueue), so scoring the root scores the whole thing.
 */
