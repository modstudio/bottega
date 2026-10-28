// concern: store-open migration window marker
/** Owns the additive migration marker that store opens wait on without stopping runs. */

import type { Database } from 'bun:sqlite'
import { pidAlive, processStartTime } from '../../../shared/process-identity.ts'
import { writeTransaction } from './db.ts'
import {
  decideMigrationWindowClaim,
  MIGRATION_WINDOW_POLL_MS,
  MIGRATION_WINDOW_WAIT_MS,
} from './migration-window-decision.ts'
import {
  activeMigrationWindow,
  MIGRATION_WINDOW_KEY,
  type MigrationWindow,
  migrationWindow,
  migrationWindowLiveness,
  parseMigrationWindow,
} from './migration-window-state.ts'

function trySetMigrationWindow(
  database: Database,
  migration: string,
  holder: Pick<MigrationWindow, 'pid' | 'startTime'> = {
    pid: process.pid,
    startTime: processStartTime(process.pid),
  },
): MigrationWindow | null {
  const marker: MigrationWindow = { migration, ...holder }
  return writeTransaction(() => {
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
      if (!active) throw new Error('migration window is already active for an unknown migration')
      return active
    }
    return null
  }, database)
}

/** Claim the window after any live migrator ahead of this caller has finished. */
export function claimMigrationWindow(database: Database, migration: string): void {
  const started = Date.now()
  for (;;) {
    const existing = trySetMigrationWindow(database, migration)
    if (!existing) return
    const active = activeMigrationWindow(database)
    const elapsedMs = Date.now() - started
    const decision = decideMigrationWindowClaim({
      holder: active
        ? {
            migration: active.marker.migration,
            pid: active.marker.pid,
            liveness: active.liveness.state,
          }
        : null,
      elapsedMs,
    })
    if (decision.action === 'claim') continue
    if (decision.action === 'refuse') throw new Error(decision.message)
    Bun.sleepSync(Math.min(MIGRATION_WINDOW_POLL_MS, MIGRATION_WINDOW_WAIT_MS - elapsedMs))
  }
}

/** Remove the marker only while this process holds it, never another migrator's. */
export function clearMigrationWindow(database: Database): void {
  writeTransaction(() => {
    const marker = migrationWindow(database)
    if (marker?.pid !== process.pid) return
    database.query('DELETE FROM schema_meta WHERE key=?').run(MIGRATION_WINDOW_KEY)
  }, database)
}
