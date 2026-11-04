import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { RecordApiRequestError } from '../record/record-api-client.ts'
import { RECORD_TASK_FLOW_NOT_FOUND_MESSAGE } from '../record/record-task-flow.ts'
import type { HostedTaskFlow } from '../record/record-task-flow-contract.ts'
import { cacheHostedTaskFlow, readThroughTaskFlow } from './task-flow-read-through.ts'
import { seedWorkflows } from './workflow-seeds.ts'

const previousRecordUrl = process.env.BOTTEGA_RECORD_API_URL
afterEach(() => {
  installRecordApiClient(createMemoryRecordApiClient())
  if (previousRecordUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = previousRecordUrl
})

function fixture() {
  const database = migratedTestDatabase()
  seedWorkflows(database)
  const projectId = newRecordId()
  database
    .query(
      `INSERT INTO project(record_id,name,path,canon,settings)
       VALUES (?,'read-through-fixture','/tmp/read-through-fixture',0,'{"trunk":"main"}')`,
    )
    .run(projectId)
  const workflowVersionId = database
    .query<{ record_id: string }, []>('SELECT record_id FROM workflow_version LIMIT 1')
    .get()!.record_id
  const catalogueVersionId = database
    .query<{ record_id: string }, []>('SELECT record_id FROM step_catalogue_version LIMIT 1')
    .get()!.record_id
  return { database, projectId, workflowVersionId, catalogueVersionId }
}

function hosted(
  ids: ReturnType<typeof fixture>,
  input: {
    taskId?: string
    flowId?: string
    stageId?: string
    stageRevision?: number
    stage?: boolean
  },
): HostedTaskFlow {
  const taskId = input.taskId ?? newRecordId()
  const flowId = input.flowId ?? newRecordId()
  const stageId = input.stageId ?? newRecordId()
  const machineA = newRecordId()
  const machineB = newRecordId()
  const stage =
    input.stage === false
      ? null
      : {
          id: stageId,
          flowRecordId: flowId,
          workflow: 'fix-defect',
          mode: 'default',
          workflowVersionId: ids.workflowVersionId,
          catalogueVersionId: ids.catalogueVersionId,
          arguments: { key: 'DEV-2098' },
          activeOrdinal: 1,
          activeSlug: 'implement',
          state: 'running' as const,
          closedStepNotes: [],
          totalSteps: 3,
          openedMachineId: machineA,
          takenOverFromMachineId: machineA,
          lastAdvancedMachineId: machineB,
          revision: input.stageRevision ?? 4,
          createdAt: '2026-11-03T10:00:00.000Z',
          updatedAt: '2026-11-03T11:00:00.000Z',
          holder: { id: machineB, displayName: 'Machine B' },
        }
  return {
    flow: {
      id: flowId,
      projectId: ids.projectId,
      taskId,
      state: 'open',
      openStageRecordId: stage?.id ?? null,
      openingMachineId: machineA,
      updatedMachineId: machineB,
      revision: 3,
      createdAt: '2026-11-03T10:00:00.000Z',
      updatedAt: '2026-11-03T11:00:00.000Z',
    },
    stage,
  }
}

function installHosted(flow: HostedTaskFlow): void {
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    readTaskFlow: async () => flow,
  })
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
}

test('hosted newer than local refreshes the cached stage', async () => {
  const ids = fixture()
  try {
    const taskId = newRecordId(),
      flowId = newRecordId(),
      stageId = newRecordId()
    cacheHostedTaskFlow(
      ids.database,
      'DEV-2098',
      hosted(ids, { taskId, flowId, stageId, stageRevision: 3 }),
    )
    installHosted(hosted(ids, { taskId, flowId, stageId, stageRevision: 4 }))
    const status = await readThroughTaskFlow(ids.database, {
      taskKey: 'DEV-2098',
      taskRecordId: taskId,
    })
    expect(status).toMatchObject({ status: 'reachable', holder: { displayName: 'Machine B' } })
    expect(
      ids.database.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(stageId),
    ).toEqual({ revision: 4 })
  } finally {
    ids.database.close()
  }
})

test('local stage ahead of hosted is not clobbered', async () => {
  const ids = fixture()
  try {
    const taskId = newRecordId(),
      flowId = newRecordId(),
      stageId = newRecordId()
    cacheHostedTaskFlow(
      ids.database,
      'DEV-2098',
      hosted(ids, { taskId, flowId, stageId, stageRevision: 6 }),
    )
    installHosted(hosted(ids, { taskId, flowId, stageId, stageRevision: 5 }))
    await readThroughTaskFlow(ids.database, { taskKey: 'DEV-2098', taskRecordId: taskId })
    expect(
      ids.database.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(stageId),
    ).toEqual({ revision: 6 })
  } finally {
    ids.database.close()
  }
})

test('hosted flow without a stage is adopted when local has no flow', async () => {
  const ids = fixture()
  try {
    const taskId = newRecordId()
    const flow = hosted(ids, { taskId, stage: false })
    installHosted(flow)
    await readThroughTaskFlow(ids.database, { taskKey: 'DEV-2098', taskRecordId: taskId })
    expect(
      ids.database
        .query('SELECT record_id,open_stage_cursor_record_id FROM task_flow WHERE task_record_id=?')
        .get(taskId),
    ).toEqual({ record_id: flow.flow.id, open_stage_cursor_record_id: null })
  } finally {
    ids.database.close()
  }
})

test('recognized task-flow not-found is a reachable empty read', async () => {
  const ids = fixture()
  try {
    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      readTaskFlow: async () => {
        throw new RecordApiRequestError(RECORD_TASK_FLOW_NOT_FOUND_MESSAGE, 'refused', 404)
      },
    })
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
    await expect(
      readThroughTaskFlow(ids.database, { taskKey: 'DEV-2098', taskRecordId: newRecordId() }),
    ).resolves.toEqual({ status: 'reachable' })
  } finally {
    ids.database.close()
  }
})

test('route-missing 404 is unreachable with the hosted-api release remedy', async () => {
  const ids = fixture()
  try {
    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      readTaskFlow: async () => {
        throw new RecordApiRequestError('record API 404', 'refused', 404)
      },
    })
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
    await expect(
      readThroughTaskFlow(ids.database, { taskKey: 'DEV-2098', taskRecordId: newRecordId() }),
    ).resolves.toEqual({
      status: 'unreachable',
      remedy: 'record API predates task-flow read; release hosted-api, then retry',
    })
  } finally {
    ids.database.close()
  }
})
