// concern: task-rulings-store
/** Loads task ruling rows for a new dispatch. Must not know prompt assembly or run claiming. */

import { db } from '../database/db.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import {
  selectTaskRulings,
  TASK_RULINGS_MAX_COUNT,
  type TaskRulingsSelection,
} from './task-rulings.ts'

export async function taskRulingsForDispatch(input: {
  resume: boolean
  project: string | null
  taskRecordId: string | null
}): Promise<TaskRulingsSelection> {
  if (input.resume || input.project === null || input.taskRecordId === null) {
    return { rulings: [], omitted: 0 }
  }
  const rows = await taskFlowReadStore(db()).taskRulingRows(
    input.project,
    input.taskRecordId,
    TASK_RULINGS_MAX_COUNT + 1,
  )
  const candidateCount = rows[0]?.candidate_count ?? 0
  const capped = rows.slice(0, TASK_RULINGS_MAX_COUNT)
  return selectTaskRulings(capped, Math.max(0, candidateCount - capped.length))
}
