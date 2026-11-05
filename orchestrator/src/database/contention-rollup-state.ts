// concern: contention rollup state
/** Owns the exclusive watermark shared by contention rollup writers and readers. */

import type { Database } from 'bun:sqlite'

const CONTENTION_ROLLUP_WATERMARK_KEY = 'contention_rollup_rolled_through_day'

export function contentionRolledThroughDay(database: Database): string | null {
  return (
    database
      .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
      .get(CONTENTION_ROLLUP_WATERMARK_KEY)?.value ?? null
  )
}

export function setContentionRolledThroughDay(database: Database, day: string | null): void {
  if (day === null) {
    database.query('DELETE FROM schema_meta WHERE key=?').run(CONTENTION_ROLLUP_WATERMARK_KEY)
    return
  }
  database
    .query(
      `INSERT INTO schema_meta(key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(CONTENTION_ROLLUP_WATERMARK_KEY, day)
}
