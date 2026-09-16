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

export async function migratePostgres(url = process.env.ORCH_RECORD_MIGRATE_URL): Promise<void> {
  if (!url) throw new Error('ORCH_RECORD_MIGRATE_URL is required to migrate the record')
  const sql = new SQL(url)
  try {
    await migrate(drizzle({ client: sql }), { migrationsFolder: POSTGRES_MIGRATIONS_FOLDER })
  } finally {
    await sql.close()
  }
}
