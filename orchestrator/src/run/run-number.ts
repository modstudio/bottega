// concern: run-identity
/** Owns the monotonic human-facing run number sequence. */

import type { Database } from 'bun:sqlite'

const RUN_COUNTER_ID = '00000000-0000-4000-8000-000000000124'

/** Allocate a run number once. Deleting the eventual run row never returns it. */
export function nextRunNumber(database: Database): number {
  const row = database
    .query<{ last_number: number }, [string]>(
      `UPDATE run_number_counter
          SET last_number=MAX(last_number, COALESCE((SELECT MAX(number) FROM run), 0))+1
        WHERE record_id=? RETURNING last_number`,
    )
    .get(RUN_COUNTER_ID)
  if (!row) throw new Error('run number counter is missing')
  return row.last_number
}
