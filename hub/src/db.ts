import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FROZEN_STATE_NAMES, PLATFORM_NAME } from '../../shared/brand.ts'
import { mainCheckoutOf } from '../../shared/git.ts'
import { isAuthorizedPlatformInstallation } from '../../shared/install-root.ts'
import { legacyStoreRefusal, resolveHubDatabase } from '../../shared/state-directory.ts'
import {
  applyMigrations,
  migrationRefusal,
  readUserVersion,
  staleWriteRefusal,
} from './migrations.ts'

export type { Project } from './projects.ts'

const checkout = fileURLToPath(new URL('../..', import.meta.url))
const mainCheckout = mainCheckoutOf(checkout)
const livePath = resolveHubDatabase(process.env)
const legacyPath = mainCheckout ? join(mainCheckout, 'hub', FROZEN_STATE_NAMES.hubDatabase) : null
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

let handle: Database | null = null
let openedUserVersion: number | null = null
let schemaReload: ((from: number, to: number) => void) | null = null
const writeDepth = new WeakMap<Database, number>()

/** Refuse a query when there is no store to query; never manufacture an empty finding. */
export function requireDatabase(): void {
  const refusal = legacyDatabaseRefusal()
  if (refusal) throw new Error(refusal)
  if (!existsSync(DB_PATH)) {
    throw new Error(`hub database is absent at ${DB_PATH}; cannot answer from missing data`)
  }
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
  if (
    !process.env.HUB_DB &&
    !isAuthorizedPlatformInstallation(
      checkout,
      process.env,
      Boolean(mainCheckout && resolve(mainCheckout) === resolve(checkout)),
    )
  ) {
    throw new Error(unauthorizedHubMigrationMessage())
  }
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const d = new Database(DB_PATH, { create: true })
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
