// concern: workflow compose cursor reuse
/** Selects or adopts a compose cursor and persists compose-time argument changes. */

import type { Database } from 'bun:sqlite'
import { writeTransaction } from '../database/db.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { taskFlowLocalStore } from './task-flow-store.ts'
import type { TaskFlowIntentInput } from './task-flow-store-types.ts'
import { selectWorkflowCursorForKeyAdoption } from './workflow-cursor-adoption.ts'
import { resolveCursorArguments, workflowKeyOf } from './workflow-cursor-arguments.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { cursorOwnerAfter } from './workflow-cursor-transition.ts'

export async function selectWorkflowCursorForCompose(input: {
  project: string
  workflow: string
  mode: string
  args: Record<string, string>
  cursor?: number
  context: WorkflowCursorContext
  database: Database
}): Promise<{ row: SelectableCursorRow | null; adopted: boolean }> {
  if (!workflowKeyOf(input.args)) return { row: null, adopted: false }
  return selectWorkflowCursorForKeyAdoption(input)
}

export async function reuseWorkflowCursor(
  existing: SelectableCursorRow,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  database: Database,
): Promise<SelectableCursorRow> {
  const resolved = resolveCursorArguments(existing, args, database, true)
  const payload: TaskFlowIntentInput<'stage-update'> = {
    requestId: taskFlowRequestId('stage-update', [existing.record_id, String(existing.revision)]),
    stages: [
      {
        id: existing.record_id,
        expectedRevision: existing.revision,
        values: {
          arguments: resolved.args,
          closedStepNotes: JSON.parse(resolved.closed) as unknown[],
          sessionId: cursorOwnerAfter('compose', existing.session_id, context.session),
          updatedAt: resolved.updatedAt,
        },
      },
    ],
  }
  const hosted = await writeHostedTaskFlow(
    'stage-update',
    payload,
    taskFlowWriteTarget(existing.project, database),
    context.taskFlowClient,
  )
  let row!: SelectableCursorRow
  writeTransaction(() => {
    const result = taskFlowLocalStore(database).write('stage-update', payload, hosted)
    row = {
      ...existing,
      args: resolved.encoded,
      closed: resolved.closed,
      session_id: context.session ?? existing.session_id,
      updated_at: resolved.updatedAt,
      revision: result.revisions[existing.record_id]!,
    }
  }, database)
  return row
}
