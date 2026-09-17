// concern: machine-identity
/** Knows the durable identity and display name of this machine. Must not know runs or hosted records. */
import { hostname } from 'node:os'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db, writeTransaction } from '../database/db.ts'

const MACHINE_ID_KEY = 'machine_id'

export function machineId(): string {
  const existing = db()
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(MACHINE_ID_KEY)
  if (existing) return existing.value

  return writeTransaction(() => {
    const raced = db()
      .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
      .get(MACHINE_ID_KEY)
    if (raced) return raced.value
    const id = newRecordId()
    db().query('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(MACHINE_ID_KEY, id)
    return id
  })
}

export function machineName(): string {
  return hostname()
}
