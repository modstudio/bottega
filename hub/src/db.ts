import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mainCheckoutOf } from '../../shared/git.ts'
import { applyMigrations, migrationRefusal, readUserVersion } from './migrations.ts'

export type { Project } from './projects.ts'

const checkout = new URL('../..', import.meta.url).pathname
const mainCheckout = mainCheckoutOf(checkout)
export const DB_PATH =
  process.env.HUB_DB ?? (mainCheckout ? join(mainCheckout, 'hub', 'hub.db') : null)

let handle: Database | null = null
let openedUserVersion: number | null = null
let schemaReload: ((from: number, to: number) => void) | null = null

/** Refuse a query when there is no store to query; never manufacture an empty finding. */
export function requireDatabase(): void {
  if (!DB_PATH) throw new Error(`cannot resolve hub database: ${checkout} has no main git checkout`)
  if (!existsSync(DB_PATH)) {
    throw new Error(`hub database is absent at ${DB_PATH}; cannot answer from missing data`)
  }
}

/** Long-lived processes (hub serve) reload instead of refusing a write after a migrate. */
export function enableSchemaReload(onReload: (from: number, to: number) => void): void {
  schemaReload = onReload
}

function reloadStaleSchema(d: Database): Database {
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
  return d
}

export function db(): Database {
  if (handle) return reloadStaleSchema(handle)
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
  `)
  handle = d
  openedUserVersion = readUserVersion(d)
  return d
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
export function nextImportedTaskKey(prefix: string): string {
  const d = db()
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
