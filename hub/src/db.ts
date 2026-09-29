import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FROZEN_STATE_NAMES, PLATFORM_NAME } from '../../shared/brand.ts'
import { embeddedDistributionManifest } from '../../shared/embedded-assets.ts'
import { mainCheckoutOf } from '../../shared/git.ts'
import { isAuthorizedPlatformInstallation } from '../../shared/install-root.ts'
import {
  legacyStoreRefusal,
  resolveHubDatabase,
  type StateEnvironment,
} from '../../shared/state-directory.ts'
import {
  applyMigrations,
  migrationRefusal,
  readUserVersion,
  staleWriteRefusal,
} from './migrations.ts'

export type { Project } from './projects.ts'

const checkout = fileURLToPath(new URL('../..', import.meta.url))
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

function legacyDatabaseRefusal(): string | null {
  if (process.env.HUB_DB || !legacyPath) return null
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

/** A test process never falls back to the live hub store; production still does. */
export function decideHubDatabasePath(
  isTestProcess: boolean,
  hubDb: string | undefined,
  liveStore: string | null,
): string | null {
  if (hubDb) return hubDb
  if (isTestProcess) {
    throw new Error(
      `test process refuses hub database: HUB_DB resolved <unset>; live store is ${liveStore ?? '<none>'}\n` +
        'invariant: A test suite never falls back to the live hub database.\n' +
        'cleared by: set HUB_DB to a scratch store before importing hub/src/db.ts',
    )
  }
  return liveStore
}

function authorizedHubInstallation(): boolean {
  return runtime.authorized
}

export function missingHubDatabaseMessage(path = DB_PATH): string {
  return (
    `hub database does not exist: ${path}\n` +
    'invariant: An absent HUB_DB path is a mistake, not a request to create a store.\n' +
    'cleared by: unset HUB_DB to use the installation store, or name an existing database'
  )
}

export function implicitHubDatabaseCreationRefusal(
  explicitPath: boolean,
  authorized: boolean,
  linked = linkedCheckout,
  path = DB_PATH,
): string | null {
  if (explicitPath) return missingHubDatabaseMessage(path)
  if (linked) {
    return (
      `refusing to initialize the hub store from a linked worktree: ${path}\n` +
      'invariant: A linked-worktree binary does not create the shared hub store.\n' +
      'cleared by: run the command from the main checkout'
    )
  }
  return authorized ? null : unauthorizedHubMigrationMessage(path)
}

let handle: Database | null = null
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
  handle = null
  openedUserVersion = null
  schemaReload = null
}

/** Long-lived processes (hub serve) reload instead of refusing a write after a migrate. */
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
  throw new Error(staleWriteRefusal(actual, opened, 'restart this process after hub migrate'))
}

export function db(): Database {
  if (handle) return refuseOrReloadStaleSchema(handle, false)
  // bun test sets NODE_ENV=test; an unset HUB_DB must not fall back to the live store.
  decideHubDatabasePath(process.env.NODE_ENV === 'test', process.env.HUB_DB, livePath)
  requireDatabase()
  const d = new Database(DB_PATH!, { readwrite: true, create: false })
  d.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
  const refused = migrationRefusal(d)
  if (refused) {
    d.close()
    throw new Error(refused)
  }
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA wal_autocheckpoint = 100;
    PRAGMA journal_size_limit = 1048576;
    PRAGMA query_only = ON;
  `)
  handle = d
  openedUserVersion = readUserVersion(d)
  return d
}

/** Open the only sanctioned multi-statement write transaction. */
export function writeTransaction<T>(fn: (conn: Database) => T, database: Database = db()): T {
  const conn = refuseOrReloadStaleSchema(database, true)
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
    `cleared by: run hub migrate from a checkout or reinstall ${PLATFORM_NAME}`
  )
}

export function formatMigrationRepairSummary(
  repairs: { reason: string; count: number }[],
): string | null {
  if (!repairs.length) return null
  return `task_identity_migration_repairs: ${repairs.map((repair) => `${repair.reason}=${repair.count}`).join(', ')}`
}

/** The only production path that creates or changes the hub schema. */
export function migrateDatabase(): {
  path: string
  versions: string[]
  repairs: { reason: string; count: number }[]
} {
  const refusal = legacyDatabaseRefusal()
  if (refusal) throw new Error(refusal)
  const create = !existsSync(DB_PATH)
  const creationRefusal = create
    ? implicitHubDatabaseCreationRefusal(Boolean(process.env.HUB_DB), authorizedHubInstallation())
    : null
  if (creationRefusal) throw new Error(creationRefusal)
  if (!create && !process.env.HUB_DB && !authorizedHubInstallation()) {
    throw new Error(unauthorizedHubMigrationMessage())
  }
  if (create) mkdirSync(dirname(DB_PATH), { recursive: true })
  const d = new Database(DB_PATH, { readwrite: true, create })
  try {
    d.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
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
    const versions = applyMigrations(d)
    const repairs = [...repairCounts()]
      .map(([reason, count]) => ({ reason, count: count - (before.get(reason) ?? 0) }))
      .filter((row) => row.count > 0)
    return { path: DB_PATH, versions, repairs }
  } finally {
    d.close()
  }
}
