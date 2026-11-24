// concern: board claim cursor binding
/** Supplies the open-cursor fact used by board claim liveness adapters. */

import type { Database } from 'bun:sqlite'
import { TASK_FLOW_OPEN_STAGE_STATES_SQL } from '../record/record-task-flow-contract.ts'

export type CursorBindableClaim = {
  project: string
  subject_kind: string
  subject_value: string
  holder_session: string | null
}

export function claimBoundToOpenCursor(row: CursorBindableClaim, database: Database): boolean {
  if (row.subject_kind !== 'task' || !row.holder_session) return false
  return Boolean(
    database
      .query(
        `SELECT 1 FROM workflow_cursor
         WHERE project=? AND workflow_key=? AND session_id=?
           AND state IN (${TASK_FLOW_OPEN_STAGE_STATES_SQL}) LIMIT 1`,
      )
      .get(row.project, row.subject_value, row.holder_session),
  )
}
