// concern: asking run lifecycle store
/** Owns the guarded architect-abandon write for an asking row. */

import type { Database } from 'bun:sqlite'

/** The error recorded by the architect abandon verb and restored from its audit. */
export function architectAbandonError(reason: string | null | undefined): string {
  return `abandoned by architect${reason == null ? '' : `: ${reason}`}`
}

/** Apply the same lifecycle value written by `bottega run abandon`. */
export function writeAskingRunAbandoned(
  database: Database,
  recordId: string,
  error: string,
): boolean {
  return (
    database
      .query(
        "UPDATE run SET status='stale', error=?, failure_kind='abandoned', own_failure_kind='abandoned', host_wait_since=NULL WHERE record_id=? AND status='asking'",
      )
      .run(error, recordId).changes === 1
  )
}
