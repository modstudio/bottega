// concern: database
/** Stores the install's machine identity. Must not know callers, runs, or hosted records. */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record/schema.ts'

const MACHINE_ID_KEY = 'machine_id'

export function machineIdStored(database: Database): string | null {
  return (
    database
      .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
      .get(MACHINE_ID_KEY)?.value ?? null
  )
}

export function machineIdFromStore(database: Database, transaction: <T>(fn: () => T) => T): string {
  const existing = machineIdStored(database)
  if (existing) return existing

  return transaction(() => {
    const raced = machineIdStored(database)
    if (raced) return raced
    const id = newRecordId()
    database.query('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(MACHINE_ID_KEY, id)
    return id
  })
}
