// concern: postgres-migrate

import { join } from 'node:path'
import { SQL } from 'bun'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { getMigrationsToRun } from 'drizzle-orm/migrator.utils'
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js'
import { migrate as migrateWithPostgresJs } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const POSTGRES_MIGRATIONS_FOLDER = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'shared',
  'record',
  'migrations',
)

export const MIGRATION_LOCK_TIMEOUT = '5s'
export const MIGRATION_STATEMENT_TIMEOUT = '60s'
export const MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT = '30s'
export const MIGRATION_CLIENT_CHECK_INTERVAL = '5s'
export const MIGRATION_NOTICE_MESSAGE_LIMIT = 500

export type MigrationNoticeSink = (line: string) => void

export function formatMigrationNotice(migrationName: string, message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim()
  const bounded =
    normalized.length > MIGRATION_NOTICE_MESSAGE_LIMIT
      ? `${normalized.slice(0, MIGRATION_NOTICE_MESSAGE_LIMIT - 2).trimEnd()} …`
      : normalized
  return `MIGRATE NOTICE ${migrationName}: ${bounded}`
}

export function migrationSessionSettings(): Array<[name: string, value: string]> {
  return [
    ['lock_timeout', MIGRATION_LOCK_TIMEOUT],
    ['statement_timeout', MIGRATION_STATEMENT_TIMEOUT],
    ['idle_in_transaction_session_timeout', MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT],
    ['client_connection_check_interval', MIGRATION_CLIENT_CHECK_INTERVAL],
  ]
}

export function recordMigrationCount(folder = POSTGRES_MIGRATIONS_FOLDER): number {
  return readMigrationFiles({ migrationsFolder: folder }).length
}

type MigrationJournalConnection = {
  unsafe: <T>(query: string) => Promise<T[]>
}

export async function pendingRecordMigrationNames(
  connection: MigrationJournalConnection,
  folder = POSTGRES_MIGRATIONS_FOLDER,
): Promise<string[]> {
  const localMigrations = readMigrationFiles({ migrationsFolder: folder })
  const present = await connection.unsafe<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='drizzle' AND table_name='__drizzle_migrations'
    ) AS present
  `)
  const journal = present[0]?.present
    ? await connection.unsafe<{ name: string | null }>(
        'SELECT name FROM drizzle.__drizzle_migrations',
      )
    : []
  const dbMigrations = journal.map((entry, id) => ({
    id,
    hash: '',
    created_at: '',
    name: entry.name,
  }))
  return getMigrationsToRun({ localMigrations, dbMigrations }).map((migration) => migration.name)
}

export async function probeRecord(url: string): Promise<void> {
  const sql = new SQL(url)
  try {
    await sql`SELECT 1`
  } finally {
    await sql.close()
  }
}

export async function appliedRecordMigrationCount(url: string): Promise<number> {
  const sql = new SQL(url)
  try {
    const present = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='drizzle' AND table_name='__drizzle_migrations'
      ) AS present
    `
    if (!present[0]?.present) return 0
    const rows = await sql`SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations`
    return Number(rows[0]?.count ?? 0)
  } finally {
    await sql.close()
  }
}

export async function migratePostgres(
  url = process.env.BOTTEGA_RECORD_MIGRATE_URL,
  noticeSink: MigrationNoticeSink = console.log,
): Promise<void> {
  return migratePostgresFolder(url, noticeSink, POSTGRES_MIGRATIONS_FOLDER)
}

type MigrationQueryTracker = {
  migrationName(): string
  logQuery(query: string): void
}

function migrationQueryTracker(
  folder: string,
  pendingNames: readonly string[],
): MigrationQueryTracker {
  const pending = new Set(pendingNames)
  const statements = readMigrationFiles({ migrationsFolder: folder })
    .filter((migration) => pending.has(migration.name))
    .flatMap((migration) => migration.sql.map((query) => ({ name: migration.name, query })))
  let index = 0
  let current = '-'
  return {
    migrationName: () => current,
    logQuery(query) {
      const expected = statements[index]
      if (expected?.query === query) {
        current = expected.name
        index += 1
      } else {
        current = '-'
      }
    },
  }
}

/** Test seam for exercising the production migrator against a fixture journal. */
export async function migratePostgresFolder(
  url: string | undefined,
  noticeSink: MigrationNoticeSink = console.log,
  folder = POSTGRES_MIGRATIONS_FOLDER,
): Promise<void> {
  if (!url) throw new Error('BOTTEGA_RECORD_MIGRATE_URL is required to migrate the record')
  let tracker: MigrationQueryTracker = {
    migrationName: () => '-',
    logQuery: () => {},
  }
  const sql = postgres(url, {
    max: 1,
    onnotice: (notice) =>
      noticeSink(formatMigrationNotice(tracker.migrationName(), notice.message ?? '')),
  })
  try {
    for (const [name, value] of migrationSessionSettings()) {
      await sql`SELECT set_config(${name}, ${value}, false)`
    }
    const pendingNames = await pendingRecordMigrationNames(sql, folder)
    tracker = migrationQueryTracker(folder, pendingNames)
    await migrateWithPostgresJs(drizzlePostgresJs({ client: sql, logger: tracker }), {
      migrationsFolder: folder,
    })
  } finally {
    await sql.end()
  }
}
