import type { Database } from 'bun:sqlite'
import { expect } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import { insertOutboxRow } from '../src/record/outbox-enqueue.ts'
import { stringifyOutboxPayload } from '../src/record/outbox-sanitize.ts'
import { syncRecord } from '../src/record/record-sync.ts'

type ProofInput = {
  database: Database
  machineId: string
  spaceId: string
  projectId: string
  projectName: string
  workflow: string
  taskKey: string
  admin(statement: string): string
}

/** Proves the legacy sync route allocates and then preserves a project-scoped stage number. */
export async function proveTaskFlowSyncPush(input: ProofInput): Promise<void> {
  const flowId = newRecordId()
  const stageId = newRecordId()
  const refusedStageId = newRecordId()
  const workflowVersionId = input.database
    .query<{ record_id: string }, [string]>(
      `SELECT version.record_id FROM workflow_version version JOIN workflow
         ON workflow.record_id=version.workflow_record_id
       WHERE workflow.slug=? AND workflow.space_id IS NOT NULL LIMIT 1`,
    )
    .get(input.workflow)!.record_id
  const catalogueVersionId = input.database
    .query<{ record_id: string }, []>(
      `SELECT version.record_id FROM step_catalogue_version version JOIN step_catalogue catalogue
         ON catalogue.record_id=version.catalogue_record_id
       WHERE catalogue.slug='shared' AND catalogue.space_id IS NOT NULL LIMIT 1`,
    )
    .get()!.record_id
  const stamp = new Date().toISOString()
  const flowPayload = {
    id: flowId,
    spaceId: input.spaceId,
    projectId: input.projectId,
    projectName: input.projectName,
    taskId: null,
    state: 'open',
    openStageRecordId: stageId,
    openingMachineId: input.machineId,
    updatedMachineId: input.machineId,
    machineId: input.machineId,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  }
  const stagePayload = {
    id: stageId,
    spaceId: input.spaceId,
    projectId: input.projectId,
    projectName: input.projectName,
    flowRecordId: flowId,
    workflow: input.workflow,
    mode: 'default',
    workflowKey: `${input.taskKey}-sync`,
    instanceId: '',
    sessionId: 'sync-proof',
    workflowVersionId,
    catalogueVersionId,
    arguments: { key: `${input.taskKey}-sync` },
    activeOrdinal: 0,
    activeSlug: 'diagnose',
    state: 'running',
    closedStepNotes: [],
    question: null,
    autonomy: null,
    enforcement: 'note-only',
    totalSteps: 3,
    openedMachineId: input.machineId,
    takenOverFromMachineId: null,
    lastAdvancedMachineId: input.machineId,
    machineId: input.machineId,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  }
  const enqueue = (kind: 'task_flow' | 'task_flow_stage', rowId: string, payload: object) =>
    insertOutboxRow(input.database, {
      recordId: newRecordId(),
      kind,
      rowId,
      payload: stringifyOutboxPayload(kind, payload as Record<string, unknown>),
      createdAt: stamp,
    })
  const sync = () =>
    syncRecord({
      local: input.database,
      identity: { id: input.machineId, name: 'Task-flow sync proof' },
      projectSpaces: { [input.projectName]: input.spaceId },
    })

  enqueue('task_flow', flowId, flowPayload)
  enqueue('task_flow_stage', stageId, stagePayload)
  expect(await sync()).toMatchObject({ failed: 0 })
  const firstIdentity = input.admin(
    `SELECT project_id || '|' || number FROM task_flow_stage WHERE id='${stageId}';`,
  )
  expect(firstIdentity).toStartWith(`${input.projectId}|`)

  enqueue('task_flow_stage', stageId, { ...stagePayload, state: 'done', revision: 2 })
  expect(await sync()).toMatchObject({ failed: 0 })
  expect(
    input.admin(`SELECT project_id || '|' || number FROM task_flow_stage WHERE id='${stageId}';`),
  ).toBe(firstIdentity)

  enqueue('task_flow_stage', refusedStageId, {
    ...stagePayload,
    id: refusedStageId,
    projectId: null,
    workflowKey: `${input.taskKey}-sync-refused`,
  })
  const refused = await sync()
  expect(refused.failed).toBe(1)
  expect(refused.quarantined).toContainEqual(
    expect.objectContaining({
      kind: 'task_flow_stage',
      error: expect.stringContaining('projectId is required for a new hosted stage'),
    }),
  )
}
