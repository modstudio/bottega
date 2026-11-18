// concern: hosted task-flow transaction adapter
/** Keeps local transactions free of hosted task-flow table access after a record write. */

import type { Database } from 'bun:sqlite'
import type {
  TaskFlowIntentInput,
  TaskFlowIntentResult,
  TaskFlowLiveIntent,
} from '../record/record-task-flow-write-contract.ts'
import type { TaskFlowSqliteWriteResult } from './task-flow-store-sqlite-write.ts'

function appliedResult<K extends TaskFlowLiveIntent>(
  intent: K,
  _input: TaskFlowIntentInput<K>,
  applied?: TaskFlowIntentResult<K> | null,
): TaskFlowSqliteWriteResult<K> {
  if (!applied)
    throw new Error(
      `hosted ${intent} task-flow write returned no result; restore record access and retry`,
    )
  return applied
}

/** Hosted mode returns record results without touching local task-flow tables. */
export function hostedTaskFlowLocalStore(_database: Database) {
  return {
    write: appliedResult,
    retireStageIdentity: () => {},
    insertStage: () => {
      throw new Error('hosted workflow stages are inserted by the record write')
    },
    cacheAdoptedFlow: () => {
      throw new Error('hosted task flows are not cached locally')
    },
    relinkProjectReferences: (_fromProjectRecordId: string, _toProjectRecordId: string) => ({
      task_flow: 0,
      workflow_cursor: 0,
    }),
    renameStageProject: (_oldProject: string, _newProject: string) => {},
  }
}
