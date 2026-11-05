// concern: SQLite table storage measurement
/** Measures a concern-owned SQLite store and attributes index pages to their table. */

import type { Database } from 'bun:sqlite'
import type { LifecycleStore, TableStorageMeasurement } from './storage-lifecycle.ts'

export function measureSqliteTables(
  database: Database,
  store: Extract<LifecycleStore, 'orchestrator' | 'hub'>,
): TableStorageMeasurement[] {
  const bytes = database
    .query<{ table_name: string; bytes: number }, []>(
      `SELECT coalesce(sqlite_master.tbl_name, dbstat.name) AS table_name,
              sum(dbstat.pgsize) AS bytes
         FROM dbstat
         LEFT JOIN sqlite_master ON sqlite_master.name = dbstat.name
        GROUP BY coalesce(sqlite_master.tbl_name, dbstat.name)`,
    )
    .all()
  const sizes = new Map(bytes.map((row) => [row.table_name, Number(row.bytes)]))
  return database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => ({
      store,
      table: name,
      bytes: sizes.get(name) ?? 0,
      rows: Number(
        database
          .query<{ rows: number }, []>(
            `SELECT count(*) AS rows FROM "${name.replaceAll('"', '""')}"`,
          )
          .get()?.rows ?? 0,
      ),
    }))
}
