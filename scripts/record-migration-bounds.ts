import type { MigrationMeta } from 'drizzle-orm/migrator'
import {
  MIGRATION_BOUNDED_PARAMETERS,
  publishedMigrationSetting,
} from '../shared/record/migration-session.ts'

type BoundedParameter = (typeof MIGRATION_BOUNDED_PARAMETERS)[number]
const boundedParameters = `(?:${MIGRATION_BOUNDED_PARAMETERS.join('|')})`
const disabledBound = new RegExp(
  `\\bSET(?:\\s+(?:LOCAL|SESSION))?\\s+${boundedParameters}\\s*(?:=|TO)\\s*(?:(?:'0(?:ms|s|min|h|d)?'|0(?:ms|s|min|h|d)?)(?=\\s|;|$)|DEFAULT\\b)`,
  'i',
)
const disabledSetConfig = new RegExp(
  `\\bset_config\\s*\\(\\s*'${boundedParameters}'\\s*,\\s*(?:'0(?:ms|s|min|h|d)?'|0(?:ms|s|min|h|d)?)(?=\\s*(?:,|\\)))`,
  'i',
)
const resetBound = new RegExp(`\\bRESET\\s+(?:${boundedParameters}|ALL)\\b`, 'i')

function statements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
}

function changedParameter(statement: string): BoundedParameter | undefined {
  const set = statement.match(
    new RegExp(`\\bSET(?:\\s+(?:LOCAL|SESSION))?\\s+(${boundedParameters})\\s*(?:=|TO)`, 'i'),
  )
  const setConfig = statement.match(
    new RegExp(`\\bset_config\\s*\\(\\s*'(${boundedParameters})'\\s*,`, 'i'),
  )
  return (set?.[1] ?? setConfig?.[1])?.toLowerCase() as BoundedParameter | undefined
}

function restoredParameter(statement: string): BoundedParameter | undefined {
  for (const parameter of MIGRATION_BOUNDED_PARAMETERS) {
    const restore = new RegExp(
      `^SELECT\\s+set_config\\s*\\(\\s*'${parameter}'\\s*,\\s*current_setting\\s*\\(\\s*'${publishedMigrationSetting(parameter)}'\\s*\\)\\s*,\\s*true\\s*\\)$`,
      'i',
    )
    if (restore.test(statement)) return parameter
  }
}

function restoreStatement(parameter: BoundedParameter): string {
  return `SELECT set_config('${parameter}', current_setting('${publishedMigrationSetting(parameter)}'), true);`
}

function assertNoDisabledBounds(migration: MigrationMeta, migrationStatements: string[]): void {
  for (const statement of migrationStatements) {
    if (
      !disabledBound.test(statement) &&
      !disabledSetConfig.test(statement) &&
      !resetBound.test(statement)
    )
      continue
    throw new Error(
      `shared/record/migrations/${migration.name}/migration.sql disables a migration session bound in ${JSON.stringify(statement)}`,
    )
  }
}

function openingRestores(migration: MigrationMeta | undefined): Set<BoundedParameter> {
  const restores = new Set<BoundedParameter>()
  if (!migration) return restores
  for (const statement of migration.sql.flatMap(statements)) {
    const restored = restoredParameter(statement)
    if (!restored) break
    restores.add(restored)
  }
  return restores
}

function unrestoredParameters(
  migrationStatements: string[],
  next: MigrationMeta | undefined,
): BoundedParameter[] {
  const lastChanges = new Map<BoundedParameter, number>()
  const lastRestores = new Map<BoundedParameter, number>()
  for (const [index, statement] of migrationStatements.entries()) {
    const restored = restoredParameter(statement)
    if (restored) lastRestores.set(restored, index)
    const changed = changedParameter(statement)
    if (changed && !restored) lastChanges.set(changed, index)
  }
  const nextRestores = openingRestores(next)
  return [...lastChanges].flatMap(([parameter, changeIndex]) =>
    (lastRestores.get(parameter) ?? -1) > changeIndex || nextRestores.has(parameter)
      ? []
      : [parameter],
  )
}

export function assertMigrationBounds(migrations: MigrationMeta[]): void {
  const ordered = [...migrations].sort((left, right) => left.name.localeCompare(right.name))
  for (const [index, migration] of ordered.entries()) {
    const migrationStatements = migration.sql.flatMap(statements)
    assertNoDisabledBounds(migration, migrationStatements)
    const unrestored = unrestoredParameters(migrationStatements, ordered[index + 1])
    if (unrestored.length > 0) {
      const additions = unrestored.map(restoreStatement).join(' ')
      throw new Error(
        `shared/record/migrations/${migration.name}/migration.sql leaves migration session bounds unrestored: ${unrestored.join(', ')}. Add after the last change: ${additions}`,
      )
    }
  }
}
