// concern: record-local-mark
/** Owns the mutable store fact that an unbound store is deliberately local. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'

export function readRecordLocalByDesign(database: Database): boolean {
  const table = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='record_local_by_design'",
    )
    .get()
  if (!table) return false
  return Boolean(database.query('SELECT 1 FROM record_local_by_design LIMIT 1').get())
}

export function setRecordLocalByDesign(database: Database, enabled: boolean): void {
  if (enabled) {
    database
      .query(
        "INSERT INTO record_local_by_design(record_id,mark) SELECT ?,'local' WHERE NOT EXISTS (SELECT 1 FROM record_local_by_design)",
      )
      .run(newRecordId())
    return
  }
  database.query('DELETE FROM record_local_by_design').run()
}
