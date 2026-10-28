// concern: store-open migration window marker
/** Owns the additive migration marker that store opens wait on without stopping runs. */

import type { Database } from 'bun:sqlite'
import { pidAlive, processStartTime } from '../../../shared/process-identity.ts'
import { writeTransaction } from './db.ts'
import {
  MIGRATION_WINDOW_KEY,
  type MigrationWindow,
  migrationWindow,
  migrationWindowLiveness,
  parseMigrationWindow,
} from './migration-window-state.ts'

export function setMigrationWindow(
  database: Database,
  migration: string,
  holder: Pick<MigrationWindow, 'pid' | 'startTime'> = {
    pid: process.pid,
    startTime: processStartTime(process.pid),
  },
): void {
  const marker: MigrationWindow = { migration, ...holder }
  writeTransaction(() => {
    const stored = database
      .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
      .get(MIGRATION_WINDOW_KEY)?.value
    const existing = stored === undefined ? null : parseMigrationWindow(stored)
    if (
      existing &&
      migrationWindowLiveness(existing, { pidAlive, processStartTime }).state === 'stale'
    ) {
      database
        .query('DELETE FROM schema_meta WHERE key=? AND value=?')
        .run(MIGRATION_WINDOW_KEY, stored!)
    }
    const inserted = database
      .query('INSERT OR IGNORE INTO schema_meta(key,value) VALUES (?,?)')
      .run(MIGRATION_WINDOW_KEY, JSON.stringify(marker))
    if (inserted.changes !== 1) {
      const active = migrationWindow(database)
      throw new Error(
        `migration window is already active for ${active?.migration ?? 'an unknown migration'} ` +
          `(holder pid ${active?.pid ?? 'unknown'})`,
      )
    }
  }, database)
}

/** Remove the marker only while this process holds it, never another migrator's. */
export function clearMigrationWindow(database: Database): void {
  writeTransaction(() => {
    const marker = migrationWindow(database)
    if (marker?.pid !== process.pid) return
    database.query('DELETE FROM schema_meta WHERE key=?').run(MIGRATION_WINDOW_KEY)
  }, database)
}
