import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from './brand.ts'

export type MigrationConnectionSettings = {
  legacyAlterTable: number
}

type ForeignKeyViolation = {
  table: string
  rowid: number | null
  parent: string
  fkid: number
}

const FOREIGN_KEY_VIOLATION_LIMIT = 5

function pragmaValue(d: Database, pragma: 'foreign_keys' | 'legacy_alter_table'): number {
  return (d.query(`PRAGMA ${pragma}`).get() as Record<typeof pragma, number>)[pragma]
}

function restoreLegacyAlterTable(d: Database, value: number): void {
  d.exec(`PRAGMA legacy_alter_table = ${value ? 'ON' : 'OFF'}`)
}

/** Establish the connection settings under which every SQLite migration journal runs. */
export function enterMigrationConnectionPolicy(d: Database): MigrationConnectionSettings {
  const settings = {
    legacyAlterTable: pragmaValue(d, 'legacy_alter_table'),
  }
  d.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = OFF')

  const foreignKeys = pragmaValue(d, 'foreign_keys')
  const legacyAlterTable = pragmaValue(d, 'legacy_alter_table')
  if (foreignKeys === 0 && legacyAlterTable === 0) return settings

  d.exec('PRAGMA foreign_keys = ON')
  restoreLegacyAlterTable(d, settings.legacyAlterTable)
  const failed = [
    foreignKeys !== 0 ? `foreign_keys remained ${foreignKeys}` : null,
    legacyAlterTable !== 0 ? `legacy_alter_table remained ${legacyAlterTable}` : null,
  ].filter((value): value is string => value !== null)
  throw new Error(
    `refusing to migrate: migration connection settings could not be established (${failed.join(', ')})\n` +
      'invariant: migrations run with foreign_keys off and legacy_alter_table off\n' +
      `cleared by: run \`${PLATFORM_SLUG} machine migrate\`, which opens its own connection`,
  )
}

/** Refuse to commit a journal that leaves any child row without its parent. */
export function assertMigrationForeignKeyIntegrity(d: Database): void {
  const broken = d.query('PRAGMA foreign_key_check').all() as ForeignKeyViolation[]
  if (!broken.length) return
  const shown = broken
    .slice(0, FOREIGN_KEY_VIOLATION_LIMIT)
    .map(
      (row) =>
        `table ${row.table}, rowid ${row.rowid ?? 'NULL'}, parent ${row.parent}, fkid ${row.fkid}`,
    )
    .join('; ')
  const remainder = broken.length > FOREIGN_KEY_VIOLATION_LIMIT ? '; ...' : ''
  throw new Error(
    `refusing to commit migration with dangling foreign keys: ${broken.length} violation(s) [${shown}${remainder}]\n` +
      `cleared by: repair the named rows, then run \`${PLATFORM_SLUG} machine migrate\``,
  )
}

/** Leave foreign keys ON and restore the connection's prior legacy rename mode. */
export function leaveMigrationConnectionPolicy(
  d: Database,
  settings: MigrationConnectionSettings,
): void {
  d.exec('PRAGMA foreign_keys = ON')
  restoreLegacyAlterTable(d, settings.legacyAlterTable)
}
