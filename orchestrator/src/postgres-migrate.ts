// concern: postgres-migrate

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

const POSTGRES_MIGRATIONS_FOLDER = join(import.meta.dir, '..', 'postgres', 'migrations')

export function recordMigrationCount(folder = POSTGRES_MIGRATIONS_FOLDER): number {
  return readdirSync(folder, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && existsSync(join(folder, entry.name, 'migration.sql')),
  ).length
}

export async function probeRecord(url: string): Promise<void> {
  const sql = new SQL(url)
  try {
    await sql`SELECT 1`
  } finally {
    await sql.close()
  }
}

export async function migratePostgres(url = process.env.ORCH_RECORD_MIGRATE_URL): Promise<void> {
  if (!url) throw new Error('ORCH_RECORD_MIGRATE_URL is required to migrate the record')
  const sql = new SQL(url)
  try {
    await migrate(drizzle({ client: sql }), { migrationsFolder: POSTGRES_MIGRATIONS_FOLDER })
  } finally {
    await sql.close()
  }
}
