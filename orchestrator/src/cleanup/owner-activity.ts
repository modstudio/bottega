// concern: cleanup owner activity
/** Gathers the shared session-seen and run-activity facts used by owner-gone decisions. */

import type { Database } from 'bun:sqlite'
import { filedIssueLoopRun } from '../issue/issue-queue.ts'

export function gatherOwnerActivity(
  database: Database,
  input: { ownerSessionId: string | null; runRecordId?: string; fallbackActivityAt: string },
) {
  const seen = input.ownerSessionId
    ? (database
        .query('SELECT last_seen FROM session_seen WHERE session_id=?')
        .get(input.ownerSessionId) as { last_seen: string } | null)
    : null
  const run = input.runRecordId
    ? (database
        .query(
          `SELECT root.record_id,root.job,root.label,
                  (SELECT COALESCE(turn.last_event_at,turn.started_at)
                     FROM run turn
                    WHERE turn.record_id=root.record_id OR turn.parent_run_record_id=root.record_id
                    ORDER BY turn.turn DESC,turn.number DESC LIMIT 1) AS at
             FROM run root WHERE root.record_id=?`,
        )
        .get(input.runRecordId) as
        | { record_id: string; job: string; label: string | null; at: string | null }
        | null)
    : input.ownerSessionId
      ? (database
          .query(
            'SELECT MAX(COALESCE(last_event_at,started_at)) AS at FROM run WHERE session_id=?',
          )
          .get(input.ownerSessionId) as { at: string | null })
      : null
  return {
    ownerSessionId: input.ownerSessionId,
    ownerLastSeenAt: seen ? Date.parse(seen.last_seen) : null,
    runLastActivityAt: Date.parse(run?.at ?? input.fallbackActivityAt),
    coordinatorRun:
      input.runRecordId !== undefined && run !== null && 'job' in run
        ? filedIssueLoopRun({ id: run.record_id, job: run.job, label: run.label }) !== null
        : false,
  }
}
