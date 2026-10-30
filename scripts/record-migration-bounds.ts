import type { MigrationMeta } from 'drizzle-orm/migrator'

const boundedParameters = '(?:lock_timeout|statement_timeout|idle_in_transaction_session_timeout)'
const disabledBound = new RegExp(
  `\\bSET(?:\\s+(?:LOCAL|SESSION))?\\s+${boundedParameters}\\s*(?:=|TO)\\s*(?:'0(?:ms|s|min|h|d)?'|0(?:ms|s|min|h|d)?)(?=\\s|;|$)`,
  'i',
)
const resetBound = new RegExp(`\\bRESET\\s+${boundedParameters}\\b`, 'i')

function statements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
}

export function assertMigrationBounds(migrations: MigrationMeta[]): void {
  for (const migration of migrations) {
    for (const statement of migration.sql.flatMap(statements)) {
      if (!disabledBound.test(statement) && !resetBound.test(statement)) continue
      throw new Error(
        `shared/record/migrations/${migration.name}/migration.sql disables a migration session bound in ${JSON.stringify(statement)}`,
      )
    }
  }
}
