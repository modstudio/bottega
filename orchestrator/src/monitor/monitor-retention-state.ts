// concern: monitor retention state
/** Owns the persisted boundary proving that monitor history has been released. */

import type { Database } from 'bun:sqlite'

const MONITOR_RELEASED_BEFORE_KEY = 'monitor_retention_released_before'

export function monitorReleasedBefore(database: Database): string | null {
  return (
    database
      .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
      .get(MONITOR_RELEASED_BEFORE_KEY)?.value ?? null
  )
}

export function recordMonitorReleasedBefore(database: Database, startedAt: string): void {
  database
    .query(
      `INSERT INTO schema_meta(key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=MAX(schema_meta.value,excluded.value)`,
    )
    .run(MONITOR_RELEASED_BEFORE_KEY, startedAt)
}
