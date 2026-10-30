// concern: postgres-migrate

import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { getMigrationsToRun } from 'drizzle-orm/migrator.utils'

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

export async function migratePostgres(url = process.env.BOTTEGA_RECORD_MIGRATE_URL): Promise<void> {
  if (!url) throw new Error('BOTTEGA_RECORD_MIGRATE_URL is required to migrate the record')
  const sql = new SQL({ url, max: 1 })
  try {
    for (const [name, value] of migrationSessionSettings()) {
      await sql`SELECT set_config(${name}, ${value}, false)`
    }
    await migrate(drizzle({ client: sql }), { migrationsFolder: POSTGRES_MIGRATIONS_FOLDER })
  } finally {
    await sql.close()
  }
}
