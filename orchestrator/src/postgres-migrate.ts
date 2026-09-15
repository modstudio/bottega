// concern: postgres-migrate

import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

const POSTGRES_MIGRATIONS_FOLDER = join(import.meta.dir, '..', 'postgres', 'migrations')

export async function migratePostgres(url: string): Promise<void> {
  const sql = new SQL(url)
  try {
    await migrate(drizzle({ client: sql }), { migrationsFolder: POSTGRES_MIGRATIONS_FOLDER })
  } finally {
    await sql.close()
  }
}
