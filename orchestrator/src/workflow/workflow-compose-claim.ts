// concern: workflow compose claim follow-through
/** Follows a persisted compose with its claim, undoing only a new cursor on refusal. */

import type { Database } from 'bun:sqlite'
import { abandonWorkflowCursor } from './workflow-cursor-mutation.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import {
  followTaskCursorClaim,
  type TaskCursorClaimPorts,
  taskClaimFollowWarning,
} from './workflow-task-claim.ts'

export async function followComposeTaskClaim(
  row: SelectableCursorRow,
  reused: boolean,
  context: WorkflowCursorContext,
  database: Database,
  ports?: TaskCursorClaimPorts,
): Promise<string | null> {
  try {
    await followTaskCursorClaim(
      {
        project: row.project,
        taskKey: row.workflow_key || null,
        session: context.session,
        verb: 'compose',
        database,
      },
      ports,
    )
    return null
  } catch (error) {
    if (reused) return row.workflow_key ? taskClaimFollowWarning(row.workflow_key, error) : null
    try {
      await abandonWorkflowCursor(row, 'task claim take failed', context, database)
    } catch (abandonError) {
      const detail = error instanceof Error ? error.message : String(error)
      const abandonDetail =
        abandonError instanceof Error ? abandonError.message : String(abandonError)
      throw new Error(
        `${detail}\nwarning: could not abandon cursor after claim failure: ${abandonDetail}`,
        { cause: error },
      )
    }
    throw error
  }
}
