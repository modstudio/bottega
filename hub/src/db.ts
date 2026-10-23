import { constants, Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FROZEN_STATE_NAMES, PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import { classifyCaller } from '../../shared/caller-classification.ts'
import type { DatabaseLockRefusalFacts } from '../../shared/database-lock-refusal.ts'
import { embeddedDistributionManifest } from '../../shared/embedded-assets.ts'
import { mainCheckoutOf } from '../../shared/git.ts'
import { installRoot, isAuthorizedPlatformInstallation } from '../../shared/install-root.ts'
import { machineId, storedMachineId } from '../../shared/machine-config.ts'
import type { QuestionIdentity } from '../../shared/orch-contract.ts'
import { createReadOnlyDatabaseAccess } from '../../shared/read-only-database-access.ts'
import {
  legacyStoreRefusal,
  realPathForPotentialPath,
  resolveHubDatabase,
  type StateEnvironment,
  temporaryStateStoreMigrationAllowed,
} from '../../shared/state-directory.ts'
import { decideStoreAccess, type StoreAccessDecision } from '../../shared/store-access.ts'
import { assertTestHubDatabasePath } from '../../shared/test-hub-database.ts'
import {
  applyMigrations,
  migrationRefusal,
  pendingMigrationTags,
  readUserVersion,
  staleWriteRefusal,
} from './migrations.ts'

export type { Project } from './projects.ts'

const checkout = installRoot()
type HubRuntime = {
  mainCheckout: string | null
  linkedCheckout: boolean
  livePath: string
  legacyPath: string | null
  authorized: boolean
}

export function resolveHubRuntime(
  checkoutPath: string,
  env: StateEnvironment,
  discoverCheckout: (path: string) => string | null = mainCheckoutOf,
): HubRuntime {
  const embedded = embeddedDistributionManifest() !== null
  const mainCheckout = embedded ? null : discoverCheckout(checkoutPath)
  return {
    mainCheckout,
    linkedCheckout: Boolean(mainCheckout && resolve(mainCheckout) !== resolve(checkoutPath)),
    livePath: resolveHubDatabase(env),
    legacyPath: mainCheckout ? join(mainCheckout, 'hub', FROZEN_STATE_NAMES.hubDatabase) : null,
    authorized: isAuthorizedPlatformInstallation(
      checkoutPath,
      env,
      Boolean(mainCheckout && resolve(mainCheckout) === resolve(checkoutPath)),
    ),
  }
}
const runtime = resolveHubRuntime(checkout, process.env)
const linkedCheckout = runtime.linkedCheckout
const livePath = runtime.livePath
const legacyPath = runtime.legacyPath
export const DB_PATH = livePath

const RESTRICTED_ACTOR_WRITE_REFUSAL =
  'refusing to write hub rows to the shared store from a worker, linked worktree, or borrowed clone\n' +
  'invariant: A restricted process reads the shared hub store and never writes or migrates it.\n' +
  'cleared by: run the command as an operator from the main checkout, or set BOTTEGA_HUB_DB to a temporary scratch copy'

/** Gather hub-specific path and caller facts for the shared store-access decision. */
export function hubStoreAccess(
  restrictedActor: boolean,
  path: string,
  temporaryDirectory = tmpdir(),
  walOrShmSidecarPresent = existsSync(`${path}-wal`) || existsSync(`${path}-shm`),
): StoreAccessDecision {
  return decideStoreAccess({
    restrictedActor,
    storePathUnderTemporaryRoot: temporaryStateStoreMigrationAllowed(
      realPathForPotentialPath(path),
      realPathForPotentialPath(temporaryDirectory),
    ),
    walOrShmSidecarPresent,
  })
}

const restrictedActor = linkedCheckout || classifyCaller(process.env).kind === 'worker'

function assertHubStoreWritable(): void {
  if (hubStoreAccess(restrictedActor, DB_PATH).writesRefused)
    throw new Error(RESTRICTED_ACTOR_WRITE_REFUSAL)
}

function legacyDatabaseRefusal(): string | null {
  if (process.env.BOTTEGA_HUB_DB || !legacyPath) return null
  return legacyStoreRefusal(
    {
      store: existsSync(legacyPath),
      wal: existsSync(`${legacyPath}-wal`),
      shm: existsSync(`${legacyPath}-shm`),
      destinationStore: existsSync(DB_PATH),
    },
    {
      legacyStore: legacyPath,
      destinationStore: DB_PATH,
    },
  )
}

function authorizedHubInstallation(): boolean {
  return runtime.authorized
}

export function missingHubDatabaseMessage(path = DB_PATH): string {
  return (
    `hub database does not exist: ${path}\n` +
    'invariant: An absent BOTTEGA_HUB_DB path is a mistake, not a request to create a store.\n' +
    'cleared by: unset BOTTEGA_HUB_DB to use the installation store, or name an existing database'
  )
}

export function implicitHubDatabaseCreationRefusal(
  explicitPath: boolean,
  authorized: boolean,
  linked = linkedCheckout,
  path = DB_PATH,
): string | null {
  if (explicitPath) return missingHubDatabaseMessage(path)
  const scratchAllowed = temporaryStateStoreMigrationAllowed(
    realPathForPotentialPath(path),
    realPathForPotentialPath(tmpdir()),
  )
  if (linked && scratchAllowed) return null
  if (linked) {
    return (
      `refusing to initialize the hub store from a linked worktree: ${path}\n` +
      'invariant: A linked-worktree binary does not create the shared hub store.\n' +
      'cleared by: run the command from the main checkout'
    )
  }
  return authorized ? null : unauthorizedHubMigrationMessage(path)
}

/** Decide whether an existing default store may be migrated. */
export function existingDefaultStoreMigrationRefusal(
  explicitPath: boolean,
  authorized: boolean,
  path = DB_PATH,
  linked = linkedCheckout,
): string | null {
  if (
    linked &&
    temporaryStateStoreMigrationAllowed(
      realPathForPotentialPath(path),
      realPathForPotentialPath(tmpdir()),
    )
  ) {
    return null
  }
  return explicitPath || authorized ? null : unauthorizedHubMigrationMessage(path)
}

let handle: Database | null = null
let readOnlyHandle: Database | null = null
const databaseAccess = createReadOnlyDatabaseAccess()
let openedUserVersion: number | null = null
let schemaReload: ((from: number, to: number) => void) | null = null
const writeDepth = new WeakMap<Database, number>()

/** Ensure an ordinary store-needing command has a current, authorized store. */
export function requireDatabase(): void {
  const refusal = legacyDatabaseRefusal()
  if (refusal) throw new Error(refusal)
  if (existsSync(DB_PATH)) return
  migrateDatabase()
}

export function closeDatabaseForFixture(): void {
  handle?.close()
  readOnlyHandle?.close()
  handle = null
  readOnlyHandle = null
  openedUserVersion = null
  schemaReload = null
}

/** Long-lived processes (bottega dashboard start) reload instead of refusing a write after a migrate. */
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
    openedUserVersion = null
    schemaReload(from, actual)
    return db()
  }
  if (!forWrite) return d
  throw new Error(
    staleWriteRefusal(
      actual,
      opened,
      `restart this process after ${PLATFORM_SLUG} machine migrate`,
    ),
  )
}

/**
 * Open the hub store read-only; immutable when it has no WAL sidecars. The immutable form is a
 * URI, which Bun's Linux SQLite accepts only with SQLITE_OPEN_URI passed explicitly.
 */
function openReadOnlyHubStore(immutable: boolean): Database {
  if (!immutable) return new Database(DB_PATH, { readonly: true })
  return new Database(
    `${pathToFileURL(DB_PATH).href}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  )
}

/** The read-only command handle: the same legacy, test-path and migration refusals as a writable open. */
function commandReadOnlyDatabase(): Database {
  if (readOnlyHandle) return refuseOrReloadStaleSchema(readOnlyHandle, false)
  const legacyRefusal = legacyDatabaseRefusal()
  if (legacyRefusal) throw new Error(legacyRefusal)
  assertTestHubDatabasePath()
  if (!existsSync(DB_PATH)) throw new Error(missingHubDatabaseMessage())
  const access = hubStoreAccess(restrictedActor, DB_PATH)
  const opened = openReadOnlyHubStore(access.openMode === 'read-only-immutable')
  opened.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
  const refused = migrationRefusal(opened)
  if (refused) {
    opened.close()
    throw new Error(refused)
  }
  readOnlyHandle = opened
  return opened
}

export function db(): Database {
  if (databaseAccess.active()) return commandReadOnlyDatabase()
  if (handle) return refuseOrReloadStaleSchema(handle, false)
  // bun test sets NODE_ENV=test; an unset BOTTEGA_HUB_DB must not fall back to the live store.
  assertTestHubDatabasePath()
  requireDatabase()
  const access = hubStoreAccess(restrictedActor, DB_PATH)
  const d =
    access.openMode === 'read-write'
      ? new Database(DB_PATH, { readwrite: true, create: false })
      : openReadOnlyHubStore(access.openMode === 'read-only-immutable')
  d.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
  const refused = migrationRefusal(d)
  if (refused) {
    d.close()
    throw new Error(refused)
  }
  if (access.openMode === 'read-write') {
    d.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 100;
      PRAGMA journal_size_limit = 1048576;
      PRAGMA query_only = ON;
    `)
  }
  handle = d
  openedUserVersion = readUserVersion(d)
  return d
}

/** Run one query command against a SQLite-enforced read-only process handle. */
export function withReadOnlyDatabaseAccess<T>(action: () => T): T {
  return databaseAccess.run(action)
}

/** Hub does not inspect another process's SQLite WAL lock holder. */
export function hubDatabaseLockHolder(): DatabaseLockRefusalFacts['holder'] {
  return { unavailable: 'lock-holder inspection is unavailable for the hub store' }
}

/** Open the only sanctioned multi-statement write transaction. */
export function writeTransaction<T>(fn: (conn: Database) => T, database?: Database): T {
  if (databaseAccess.active()) throw new Error('refusing a write from a read-only command')
  assertHubStoreWritable()
  const target = database ?? db()
  const conn = refuseOrReloadStaleSchema(target, true)
  const depth = writeDepth.get(conn) ?? 0
  if (depth === 0) conn.exec('PRAGMA query_only = OFF')
  writeDepth.set(conn, depth + 1)
  try {
    return conn.transaction(() => fn(conn)).immediate()
  } finally {
    if (depth === 0) {
      writeDepth.delete(conn)
      conn.exec('PRAGMA query_only = ON')
    } else {
      writeDepth.set(conn, depth)
    }
  }
}

export const nowIso = () => new Date().toISOString()

export function unauthorizedHubMigrationMessage(path = DB_PATH): string {
  return (
    `refusing to migrate the default store: cannot establish an authorized ${PLATFORM_NAME} installation: ${path}\n` +
    'invariant: A default store is created or migrated only by a checkout or an installed distribution.\n' +
    `cleared by: run ${PLATFORM_SLUG} machine migrate from a checkout or reinstall ${PLATFORM_NAME}`
  )
}

export function formatMigrationRepairSummary(
  repairs: { reason: string; count: number }[],
): string | null {
  if (!repairs.length) return null
  return `task_identity_migration_repairs: ${repairs.map((repair) => `${repair.reason}=${repair.count}`).join(', ')}`
}

type MigrationResult = {
  path: string
  versions: string[]
  repairs: { reason: string; count: number }[]
}

export async function questionIdentitiesForMigrations(
  d: Database,
  readQuestionIdentities: () => Promise<readonly QuestionIdentity[]>,
): Promise<readonly QuestionIdentity[]> {
  if (!pendingMigrationTags(d).includes('0036_question_uuid_key')) return []
  try {
    return await readQuestionIdentities()
  } catch (error) {
    throw new Error(
      `refusing question UUID migration: could not obtain the orchestrator identity map; ` +
        `run ${PLATFORM_SLUG} machine migrate\n${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function openMigrationDatabase(): { database: Database; create: boolean } {
  if (hubStoreAccess(restrictedActor, DB_PATH).migrationsRefused)
    throw new Error(RESTRICTED_ACTOR_WRITE_REFUSAL)
  const refusal = legacyDatabaseRefusal()
  if (refusal) throw new Error(refusal)
  const create = !existsSync(DB_PATH)
  const creationRefusal = create
    ? implicitHubDatabaseCreationRefusal(
        Boolean(process.env.BOTTEGA_HUB_DB),
        authorizedHubInstallation(),
      )
    : null
  if (creationRefusal) throw new Error(creationRefusal)
  const authorizationRefusal = !create
    ? existingDefaultStoreMigrationRefusal(
        Boolean(process.env.BOTTEGA_HUB_DB),
        authorizedHubInstallation(),
      )
    : null
  if (authorizationRefusal) throw new Error(authorizationRefusal)
  if (create) mkdirSync(dirname(DB_PATH), { recursive: true })
  const database = new Database(DB_PATH, { readwrite: true, create })
  database.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
  return { database, create }
}

function migrateOpenDatabase(
  d: Database,
  create: boolean,
  questionIdentities: readonly QuestionIdentity[],
): MigrationResult {
  const repairCounts = () => {
    const exists = d
      .query<{ count: number }, []>(
        "SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='task_identity_migration_repairs'",
      )
      .get()?.count
    return new Map(
      exists
        ? d
            .query<{ reason: string; count: number }, []>(
              `SELECT reason,COUNT(*) count FROM task_identity_migration_repairs
               GROUP BY reason ORDER BY reason`,
            )
            .all()
            .map((row) => [row.reason, row.count] as const)
        : [],
    )
  }
  const before = repairCounts()
  const identity = create ? machineId() : storedMachineId()
  if (!identity)
    throw new Error(
      `refusing to migrate hub before carrying over the machine identity; run ${PLATFORM_SLUG} machine migrate`,
    )
  const versions = applyMigrations(d, undefined, { machine_id: identity }, questionIdentities)
  const repairs = [...repairCounts()]
    .map(([reason, count]) => ({ reason, count: count - (before.get(reason) ?? 0) }))
    .filter((row) => row.count > 0)
  return { path: DB_PATH, versions, repairs }
}

/** The only production path that creates or changes the hub schema. */
export function migrateDatabase(
  questionIdentities: readonly QuestionIdentity[] = [],
): MigrationResult {
  const { database, create } = openMigrationDatabase()
  try {
    return migrateOpenDatabase(database, create, questionIdentities)
  } finally {
    database.close()
  }
}

export async function migrateDatabaseWithQuestionIdentityMap(
  readQuestionIdentities: () => Promise<readonly QuestionIdentity[]>,
): Promise<MigrationResult> {
  const { database, create } = openMigrationDatabase()
  try {
    const questionIdentities = await questionIdentitiesForMigrations(
      database,
      readQuestionIdentities,
    )
    return migrateOpenDatabase(database, create, questionIdentities)
  } finally {
    database.close()
  }
}
