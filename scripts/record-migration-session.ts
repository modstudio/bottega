import type { Transaction } from '@electric-sql/pglite'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import { migrationSessionSettings } from '../shared/record/migration-session.ts'
import { assertMigrationBounds } from './record-migration-bounds.ts'

export async function prepareRecordMigrationProof(
  transaction: Transaction,
  migrations: MigrationMeta[],
): Promise<Map<string, string>> {
  assertMigrationBounds(migrations)
  const effective = new Map<string, string>()
  for (const [name, value] of migrationSessionSettings()) {
    const result = await transaction.query<{ set_config: string }>(
      'SELECT set_config($1, $2, false)',
      [name, value],
    )
    effective.set(name, result.rows[0]?.set_config ?? '')
  }
  for (const name of ['lock_timeout', 'statement_timeout']) {
    const shown = await transaction.query<Record<string, string>>(`SHOW ${name}`)
    if (shown.rows[0]?.[name] !== effective.get(name)) {
      throw new Error(`${name} is not in force inside the migration transaction`)
    }
  }
  return effective
}
