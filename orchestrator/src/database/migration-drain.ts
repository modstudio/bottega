// concern: migration drain marker
/** Stores the machine-wide migration drain that blocks new run admission. */

import type { Database } from 'bun:sqlite'
import { writeTransaction } from './db.ts'

const MIGRATION_DRAIN_KEY = 'migration_drain'

export function migrationDrain(database: Database): string | null {
  return (
    database
      .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
      .get(MIGRATION_DRAIN_KEY)?.value ?? null
  )
}

export function setMigrationDrain(database: Database, migration: string): void {
  writeTransaction(() => {
    const inserted = database
      .query('INSERT OR IGNORE INTO schema_meta(key,value) VALUES (?,?)')
      .run(MIGRATION_DRAIN_KEY, migration)
    if (inserted.changes !== 1) {
      throw new Error(`migration drain is already active for ${migrationDrain(database)}`)
    }
  }, database)
}

export function clearMigrationDrain(database: Database): void {
  writeTransaction(
    () => database.query('DELETE FROM schema_meta WHERE key=?').run(MIGRATION_DRAIN_KEY),
    database,
  )
}
