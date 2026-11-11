// concern: workflow cursor task adoption
/** Atomically adopts a task key and republishes every cursor-bound question. */
import type { Database } from 'bun:sqlite'
import { nowIso, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import {
  attachTaskFlowStage,
  cacheAdoptedTaskFlow,
  selectTaskFlowStage,
  vacateRetiredWorkflowKeySlot,
} from './task-flow.ts'
import { taskFlowStore } from './task-flow-store.ts'

type AdoptionCursor = {
  id: number
  record_id: string
  project: string
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  task_record_id: string | null
  args: string
  revision: number
}

function assignWorkflowTaskKey(
  row: AdoptionCursor,
  key: string,
  taskRecordId: string | null,
  d: Database,
): void {
  vacateRetiredWorkflowKeySlot(row.project, row.workflow_slug, row.mode_slug, key, d)
  const adoptedArgs = { ...(JSON.parse(row.args) as Record<string, string>), key }
  taskFlowStore(d).assignStageTaskKey({
    recordId: row.record_id,
    workflowKey: key,
    taskRecordId,
    argumentsJson: JSON.stringify(adoptedArgs),
    updatedAt: nowIso(),
  })
  row.workflow_key = key
  row.task_record_id = taskRecordId
  row.args = JSON.stringify(adoptedArgs)
  const questions = d
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM question WHERE workflow_cursor_record_id=? ORDER BY number',
    )
    .all(row.record_id)
  for (const question of questions) {
    d.query(
      'UPDATE question SET workflow_key=?,workflow_task_record_id=?,revision=revision+1 WHERE record_id=?',
    ).run(key, taskRecordId, question.record_id)
    enqueueQuestionRecord(d, question.record_id)
  }
}

export async function adoptWorkflowTask(
  row: AdoptionCursor,
  suppliedTask: string | undefined,
  taskRecordId: string | null | undefined,
  d: Database,
  client?: RecordTaskFlowClient,
  statusCategory?: string | null,
): Promise<void> {
  const key = suppliedTask?.trim()
  if (!key) return
  if (row.workflow_key) {
    if (row.workflow_key !== key)
      throw new Error(
        `cursor ${row.id} is already assigned to ${row.workflow_key}; it cannot adopt ${key}`,
      )
    return
  }
  const conflict = conflictingAdoptionCursor(row, key, d)
  if (conflict)
    throw new Error(
      `cursor ${row.id} cannot adopt ${key}; open cursor ${conflict.id} already holds it`,
    )
  const adoptedTaskId = taskRecordId ?? null
  if (adoptedTaskId) {
    const at = nowIso()
    const target = taskFlowWriteTarget(row.project, d)
    const adopted = await writeHostedTaskFlow(
      'adopt',
      {
        requestId: taskFlowRequestId('adopt', [row.record_id, String(row.revision)]),
        stage: { id: row.record_id, expectedRevision: row.revision },
        taskId: adoptedTaskId,
        updatedMachineId: machineId(),
        updatedAt: at,
      },
      target,
      client,
    )
    let stageRevision = adopted?.revisions[row.record_id] ?? row.revision
    if (adopted) {
      const adoptedArgs = { ...(JSON.parse(row.args) as Record<string, string>), key }
      const updated = await writeHostedTaskFlow(
        'stage-update',
        {
          requestId: taskFlowRequestId('stage-update', [row.record_id, String(stageRevision)]),
          stages: [
            {
              id: row.record_id,
              expectedRevision: stageRevision,
              values: { workflowKey: key, arguments: adoptedArgs, updatedAt: at },
            },
          ],
        },
        target,
        client,
      )
      stageRevision = updated?.revisions[row.record_id] ?? stageRevision
    }
    writeTransaction(() => {
      const currentRevision = taskFlowStore(d).stageRevision(row.record_id)
      if (currentRevision !== row.revision)
        throw new Error(
          `workflow cursor ${row.id} changed while adopting ${key}; rerun the command`,
        )
      assignWorkflowTaskKey(row, key, adoptedTaskId, d)
      if (adopted)
        cacheAdoptedTaskFlow(
          {
            project: row.project,
            taskRecordId: adoptedTaskId,
            cursorRecordId: row.record_id,
            flowRecordId: adopted.flowRecordId,
            flowRevision: adopted.revisions[adopted.flowRecordId]!,
            stageRevision,
            statusCategory,
            at,
          },
          d,
        )
      else {
        const flow = selectTaskFlowStage(
          {
            project: row.project,
            taskRecordId: adoptedTaskId,
            taskKey: key,
            cursor: row.id,
            workflow: row.workflow_slug,
            mode: row.mode_slug,
          },
          d,
        )
        attachTaskFlowStage(flow.flowRecordId, row.record_id, d)
      }
    }, d)
    return
  }
  assignWorkflowTaskKey(row, key, null, d)
}

function conflictingAdoptionCursor(
  row: AdoptionCursor,
  key: string,
  database: Database,
): { id: number } | null {
  return taskFlowStore(database).stageHoldingTaskKey({
    project: row.project,
    workflow: row.workflow_slug,
    mode: row.mode_slug,
    key,
  })
}
