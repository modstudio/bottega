// concern: hosted task-flow transaction adapter
/** Keeps local transactions free of hosted task-flow table access after a record write. */

import type { Database } from 'bun:sqlite'
import type {
  TaskFlowIntent,
  TaskFlowIntentInput,
  TaskFlowIntentResult,
} from '../record/record-task-flow-write-contract.ts'
import type { TaskFlowSqliteWriteResult } from './task-flow-store-sqlite-write.ts'

const mirrorIntents = new Set<TaskFlowIntent>([
  'stage-update',
  'advance',
  'await-ruling',
  'abandon',
  'adopt',
])

function stageIds<K extends TaskFlowIntent>(intent: K, input: TaskFlowIntentInput<K>): string[] {
  const body = input as Record<string, unknown>
  if (intent === 'stage-update') return (body.stages as Array<{ id: string }>).map(({ id }) => id)
  const stage = body.stage as { id: string } | undefined
  return stage ? [stage.id] : []
}

function appliedResult<K extends TaskFlowIntent>(
  intent: K,
  input: TaskFlowIntentInput<K>,
  applied?: TaskFlowIntentResult<K> | null,
): TaskFlowSqliteWriteResult<K> {
  if (!applied)
    throw new Error(
      `hosted ${intent} task-flow write returned no result; restore record access and retry`,
    )
  return {
    ...applied,
    ...(mirrorIntents.has(intent)
      ? { mirror: Object.fromEntries(stageIds(intent, input).map((id) => [id, 'keep'])) }
      : {}),
  } as TaskFlowSqliteWriteResult<K>
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
