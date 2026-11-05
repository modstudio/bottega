// concern: applied migration compatibility
/** Reads compatibility recorded by the store without consulting this process's journal. */
import type { Database } from 'bun:sqlite'

export const MIGRATIONS_TABLE = 'orch_migrations'

export function hasMigrationCompatibilityColumn(d: Database): boolean {
  return Boolean(
    d
      .query(`SELECT 1 FROM pragma_table_info(?) WHERE name = 'compatibility'`)
      .get(MIGRATIONS_TABLE),
  )
}

export function appliedMigrationCompatibilities(d: Database): Array<string | null> {
  const table = d
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(MIGRATIONS_TABLE)
  if (!table) return []
  if (!hasMigrationCompatibilityColumn(d)) return []
  return d
    .query(`SELECT compatibility FROM ${MIGRATIONS_TABLE} ORDER BY id`)
    .all()
    .map((row) => (row as { compatibility: string | null }).compatibility)
}
