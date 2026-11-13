// concern: task-flow mirror refresh
/** Owns the follow-up refresh after a hosted write finds a stale local task-flow mirror. */

import type { Database } from 'bun:sqlite'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { readThroughTaskFlow } from './task-flow-read-through.ts'
import { taskFlowReadStore } from './task-flow-store.ts'

type MirrorRefreshStage = {
  recordId: string
  project: string
  taskKey: string
  taskRecordId: string | null
}

export async function refreshStaleMirror(
  database: Database,
  stage: MirrorRefreshStage,
  client: RecordTaskFlowClient | undefined,
) {
  const row = await taskFlowReadStore(database, client).stageByRecordId(stage.recordId)
  if (!row)
    throw new Error(
      `hosted workflow stage ${stage.recordId} was written but cannot be read back from the record; run \`bottega record doctor\`, then retry`,
    )
  if (stage.taskRecordId)
    await readThroughTaskFlow(
      database,
      {
        project: stage.project,
        taskKey: stage.taskKey,
        taskRecordId: stage.taskRecordId,
      },
      client,
    )
  return row
}
