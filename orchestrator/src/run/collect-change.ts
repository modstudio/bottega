// concern: collect-change
/** Reads and validates the monotonic source cursor used by external collectors. */
import { db } from '../database/db.ts'

export function collectChangeCursor(): number {
  return (
    db().query<{ value: number }, []>('SELECT value FROM collect_change_counter WHERE id=1').get()
      ?.value ?? 0
  )
}

export function changedAfter(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('--changed-after must be a non-negative integer')
  return parsed
}
