// concern: board-claims
/** Owns renewal of the live queued claims held by one session. */

import type { Database } from 'bun:sqlite'
import { writeTransaction } from '../database/db.ts'

export function renewLiveQueuedClaimsOfSession(
  session: string,
  clock: number,
  database: Database,
): number {
  return writeTransaction(() => {
    const now = new Date(clock).toISOString()
    const rows = database
      .query<{ record_id: string; duration_ms: number }, [string, string]>(
        `SELECT record_id,duration_ms FROM board_claim
         WHERE holder_session=? AND subject_kind='queued-task' AND closed_at IS NULL AND lapses_at>?`,
      )
      .all(session, now)
    const renew = database.query(
      'UPDATE board_claim SET renewed_at=?,lapses_at=? WHERE record_id=?',
    )
    for (const row of rows)
      renew.run(now, new Date(clock + row.duration_ms).toISOString(), row.record_id)
    return rows.length
  }, database)
}
