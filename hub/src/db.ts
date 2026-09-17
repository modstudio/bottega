import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mainCheckoutOf } from '../../shared/git.ts'
import {
  applyMigrations,
  migrationRefusal,
  readUserVersion,
  staleWriteRefusal,
} from './migrations.ts'

export type { Project } from './projects.ts'

const checkout = new URL('../..', import.meta.url).pathname
const mainCheckout = mainCheckoutOf(checkout)
const livePath = mainCheckout ? join(mainCheckout, 'hub', 'hub.db') : null
export const DB_PATH = process.env.HUB_DB ?? livePath

/** A test process never falls back to the live hub store; production still does. */
export function decideHubDatabasePath(
  isTestProcess: boolean,
  hubDb: string | undefined,
  liveStore: string | null,
): string | null {
  if (hubDb !== undefined) return hubDb
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
  if (!DB_PATH) throw new Error(`cannot resolve hub database: ${checkout} has no main git checkout`)
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

/** The only production path that creates or changes the hub schema. */
export function migrateDatabase(): { path: string; versions: string[] } {
  if (!DB_PATH) throw new Error(`cannot resolve hub database: ${checkout} has no main git checkout`)
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const d = new Database(DB_PATH, { create: true })
  try {
    d.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
    return { path: DB_PATH, versions: applyMigrations(d) }
  } finally {
    d.close()
  }
}

/** Used only inside the task-import transaction, which supplies the write lock. */
export function nextImportedTaskKey(prefix: string, d: Database): string {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`, 'i')
  const highest = d
    .query<{ key: string }, []>(`SELECT key FROM task`)
    .all()
    .reduce((max, row) => {
      const match = pattern.exec(row.key)
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
  const name = `task:${prefix}`
  const sequence = d
    .query<{ next: number }, [string]>(`SELECT next FROM seq WHERE name = ?`)
    .get(name)
  const number = Math.max(highest + 1, sequence?.next ?? 1)
  d.query(
    `INSERT INTO seq (name, next) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET next = excluded.next`,
  ).run(name, number + 1)
  return `${prefix.toUpperCase()}-${number}`
}
