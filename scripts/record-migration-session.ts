import type { Transaction } from '@electric-sql/pglite'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import {
  MIGRATION_BOUNDED_PARAMETERS,
  migrationSessionSettings,
} from '../shared/record/migration-session.ts'
import { assertMigrationBounds } from './record-migration-bounds.ts'

export async function verifyMigrationSessionBounds(
  transaction: Transaction,
  expected: ReadonlyMap<string, string>,
  parameters: readonly string[],
): Promise<void> {
  for (const parameter of parameters) {
    const shown = await transaction.query<Record<string, string>>(`SHOW ${parameter}`)
    const actual = shown.rows[0]?.[parameter]
    const expectedValue = expected.get(parameter)
    if (actual !== expectedValue) {
      throw new Error(
        `${parameter} is ${JSON.stringify(actual)} instead of ${JSON.stringify(expectedValue)}`,
      )
    }
  }
}

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
  await verifyMigrationSessionBounds(transaction, effective, MIGRATION_BOUNDED_PARAMETERS)
  return effective
}
