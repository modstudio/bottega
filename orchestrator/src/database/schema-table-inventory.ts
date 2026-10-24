// concern: database schema table inventory
/** Reads application tables while excluding lifecycle metadata and transient names. */
import type { Database } from 'bun:sqlite'

export type SchemaTableRow = { name: string; sql: string }

export function schemaTableRows(
  database: Database,
  excludedNames: readonly [string, string],
  excludedPrefix: string,
): SchemaTableRow[] {
  return database
    .query(
      `SELECT name, sql FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (?, ?)
         AND substr(name, 1, ?) != ?
       ORDER BY name`,
    )
    .all(...excludedNames, excludedPrefix.length, excludedPrefix) as SchemaTableRow[]
}
