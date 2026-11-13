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
import { refuseTaskFlowStageConflictLocal, vacateRetiredWorkflowKeySlot } from './task-flow.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'

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
  _statusCategory?: string | null,
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
  const conflict = await conflictingAdoptionCursor(row, key, d, client)
  if (conflict)
    throw new Error(
      `cursor ${row.id} cannot adopt ${key}; open cursor ${conflict.id} already holds it`,
    )
  const adoptedTaskId = taskRecordId ?? null
  if (adoptedTaskId) {
    const at = nowIso()
    const target = taskFlowWriteTarget(row.project, d)
    const adoptPayload = {
      requestId: taskFlowRequestId('adopt', [row.record_id, String(row.revision)]),
      stage: { id: row.record_id, expectedRevision: row.revision },
      taskId: adoptedTaskId,
      updatedMachineId: machineId(),
      updatedAt: at,
    }
    const adopted = await writeHostedTaskFlow('adopt', adoptPayload, target, client)
    let stageRevision = adopted?.revisions[row.record_id] ?? row.revision + 1
    const adoptedArgs = { ...(JSON.parse(row.args) as Record<string, string>), key }
    const updatePayload = {
      requestId: taskFlowRequestId('stage-update', [row.record_id, String(stageRevision)]),
      stages: [
        {
          id: row.record_id,
          expectedRevision: stageRevision,
          values: { workflowKey: key, arguments: adoptedArgs, updatedAt: at },
        },
      ],
    }
    const updated = await writeHostedTaskFlow('stage-update', updatePayload, target, client)
    writeTransaction(() => {
      refuseTaskFlowStageConflictLocal(
        {
          taskRecordId: adoptedTaskId,
          taskKey: key,
          cursor: row.id,
          workflow: row.workflow_slug,
          mode: row.mode_slug,
        },
        d,
      )
      taskFlowLocalStore(d).write('adopt', adoptPayload, adopted)
      stageRevision = taskFlowLocalStore(d).write('stage-update', updatePayload, updated).revisions[
        row.record_id
      ]!
      assignWorkflowTaskKey(row, key, adoptedTaskId, d)
    }, d)
    return
  }
  const at = nowIso()
  const payload = {
    requestId: taskFlowRequestId('stage-update', [row.record_id, String(row.revision)]),
    stages: [
      {
        id: row.record_id,
        expectedRevision: row.revision,
        values: {
          workflowKey: key,
          arguments: { ...(JSON.parse(row.args) as Record<string, string>), key },
          updatedAt: at,
        },
      },
    ],
  }
  writeTransaction(() => {
    taskFlowLocalStore(d).write('stage-update', payload)
    assignWorkflowTaskKey(row, key, null, d)
  }, d)
}

async function conflictingAdoptionCursor(
  row: AdoptionCursor,
  key: string,
  database: Database,
  client?: RecordTaskFlowClient,
): Promise<{ id: number } | null> {
  return taskFlowReadStore(database, client).stageHoldingTaskKey({
    project: row.project,
    workflow: row.workflow_slug,
    mode: row.mode_slug,
    key,
  })
}
