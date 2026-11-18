// concern: workflow finish live writer adapter
/** Reads live root runs for the pure workflow finish guard. */

import type { Database } from 'bun:sqlite'
import { job } from '../jobs/jobs.ts'
import { RUN_LIVE_STATUSES } from '../run/run-status.ts'
import { workflowCursorReference } from './workflow-cursor-format.ts'
import { decideFinishWithLiveWriter, type LiveWriterRun } from './workflow-finish-live-writer.ts'

function liveRunsForWorkflowKey(database: Database, taskKey: string): LiveWriterRun[] {
  const placeholders = RUN_LIVE_STATUSES.map(() => '?').join(',')
  const rows = database
    .query<{ number: number; job: string; session_id: string | null }, [string, ...string[]]>(
      `SELECT number,job,session_id FROM run
       WHERE parent_run_record_id IS NULL AND launch_key=? AND status IN (${placeholders})
       ORDER BY number`,
    )
    .all(taskKey, ...RUN_LIVE_STATUSES)
  return rows.map((run) => ({
    number: run.number,
    job: run.job,
    writes: (() => {
      try {
        return Boolean(job(run.job).needs.writesRepo)
      } catch {
        return false
      }
    })(),
    session: run.session_id,
  }))
}

export function refuseFinishWithLiveWriter(
  database: Database,
  row: { workflow_key: string; id: number; project: string; session_id: string | null },
  finishes: boolean,
  callerSession: string | null | undefined,
): void {
  const taskKey = row.workflow_key || null
  const refusal = decideFinishWithLiveWriter({
    finishes,
    taskKey,
    cursor: row.id,
    cursorSession: row.session_id,
    callerSession,
    cursorReference: workflowCursorReference(row.id, row.project).cli,
    runs: finishes && taskKey ? liveRunsForWorkflowKey(database, taskKey) : [],
  })
  if (refusal) throw new Error(refusal)
}
