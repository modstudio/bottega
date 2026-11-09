import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { RecordApiRequestError } from '../record/record-api-client.ts'
import {
  type HostedTaskFlow,
  RECORD_TASK_FLOW_NOT_FOUND_MESSAGE,
} from '../record/record-task-flow-contract.ts'
import { cacheHostedTaskFlow, readThroughTaskFlow } from './task-flow-read-through.ts'
import { resolveWorkflowCursorContext, selectWorkflowCursor } from './workflow-cursor-selection.ts'
import { selectAndNextWorkflowStep, testPorts } from './workflow-cursor-test.fixture.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { resolveLinkedWorkflowCursorMode } from './workflow-task-linking.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

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
      `INSERT INTO project(record_id,name,path,stack,canon,settings)
       VALUES (?,'read-through-fixture','/tmp/read-through-fixture','bun',0,
         '{"trunk":"main","docs":{"protocol":"orch-docs"},"tracker":{"protocol":"hub"}}')`,
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
    workflow?: string
    workflowVersionId?: string
    activeOrdinal?: number
    activeSlug?: string
    totalSteps?: number
    closedStepNotes?: unknown[]
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
          workflow: input.workflow ?? 'fix-defect',
          mode: 'default',
          workflowVersionId: input.workflowVersionId ?? ids.workflowVersionId,
          catalogueVersionId: ids.catalogueVersionId,
          arguments: { key: 'DEV-2098' },
          activeOrdinal: input.activeOrdinal ?? 1,
          activeSlug: input.activeSlug ?? 'fix',
          state: 'running' as const,
          closedStepNotes: input.closedStepNotes ?? [],
          totalSteps: input.totalSteps ?? 6,
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

test('hosted stage vacates a retired local cursor holding its keyed slot', () => {
  const ids = fixture()
  try {
    const taskId = newRecordId()
    const flowId = newRecordId()
    const retiredStageId = newRecordId()
    const hostedStageId = newRecordId()
    cacheHostedTaskFlow(
      ids.database,
      'DEV-2098',
      hosted(ids, { taskId, flowId, stageId: retiredStageId }),
    )
    ids.database
      .query("UPDATE workflow_cursor SET state='abandoned' WHERE record_id=?")
      .run(retiredStageId)
    const retired = ids.database
      .query<{ number: number }, [string]>('SELECT number FROM workflow_cursor WHERE record_id=?')
      .get(retiredStageId)!

    cacheHostedTaskFlow(
      ids.database,
      'DEV-2098',
      hosted(ids, { taskId, flowId, stageId: hostedStageId, stageRevision: 5 }),
    )

    expect(
      ids.database
        .query('SELECT record_id,instance_id FROM workflow_cursor WHERE record_id IN (?,?)')
        .all(retiredStageId, hostedStageId),
    ).toEqual([
      { record_id: retiredStageId, instance_id: `#${retired.number}` },
      { record_id: hostedStageId, instance_id: '' },
    ])
    expect(
      ids.database
        .query('SELECT open_stage_cursor_record_id FROM task_flow WHERE record_id=?')
        .get(flowId),
    ).toEqual({ open_stage_cursor_record_id: hostedStageId })
  } finally {
    ids.database.close()
  }
})

test('hosted stage refuses an open local cursor holding its keyed slot and rolls back', () => {
  const ids = fixture()
  try {
    const taskId = newRecordId()
    const flowId = newRecordId()
    const localStageId = newRecordId()
    const hostedStageId = newRecordId()
    cacheHostedTaskFlow(
      ids.database,
      'DEV-2098',
      hosted(ids, { taskId, flowId, stageId: localStageId }),
    )
    const local = ids.database
      .query<{ number: number }, [string]>('SELECT number FROM workflow_cursor WHERE record_id=?')
      .get(localStageId)!
    const flowBefore = ids.database
      .query(
        'SELECT open_stage_cursor_record_id,revision,updated_at FROM task_flow WHERE record_id=?',
      )
      .get(flowId)
    const cursorBefore = ids.database
      .query('SELECT * FROM workflow_cursor WHERE record_id=?')
      .get(localStageId)
    const incoming = hosted(ids, { taskId, flowId, stageId: hostedStageId, stageRevision: 5 })
    incoming.flow.revision = 8
    incoming.flow.updatedAt = '2026-11-03T12:00:00.000Z'

    expect(() => cacheHostedTaskFlow(ids.database, 'DEV-2098', incoming)).toThrow(
      new RegExp(
        `local cursor ${local.number} \\(${localStageId}\\) conflicts with hosted stage ${hostedStageId}.*${PLATFORM_SLUG} workflow abandon --cursor ${local.number}`,
      ),
    )
    expect(
      ids.database
        .query(
          'SELECT open_stage_cursor_record_id,revision,updated_at FROM task_flow WHERE record_id=?',
        )
        .get(flowId),
    ).toEqual(flowBefore)
    expect(
      ids.database.query('SELECT * FROM workflow_cursor WHERE record_id=?').get(localStageId),
    ).toEqual(cursorBefore)
    expect(
      ids.database
        .query('SELECT record_id FROM workflow_cursor WHERE record_id=?')
        .get(hostedStageId),
    ).toBeNull()
  } finally {
    ids.database.close()
  }
})

test.each([
  ['argv key', { key: 'DEV-2098' }],
  ['cursor row key', {}],
] as const)('hosted advance is taken over using the %s', async (_label, callArgs) => {
  const ids = fixture()
  try {
    const workflow = 'hosted-takeover'
    const draft = setWorkflowLocal(
      workflow,
      {
        title: 'Hosted takeover fixture',
        description: 'Exercises read-through before a cursor close.',
        arguments: [{ name: 'key', required: true, description: 'Task key.' }],
        modes: [
          {
            slug: 'default',
            title: 'Default',
            default: true,
            steps: ['diagnose', 'fix-defect-fix'],
          },
        ],
      },
      'hosted takeover fixture',
      'test',
      ids.database,
    )
    promoteWorkflowLocal(workflow, draft.n, 'publish hosted takeover fixture', 'test', ids.database)
    const workflowVersionId = ids.database
      .query<{ record_id: string }, [string]>(
        `SELECT version.record_id FROM workflow_version version
         JOIN workflow ON workflow.record_id=version.workflow_record_id
         WHERE workflow.slug=? AND version.status='production'`,
      )
      .get(workflow)!.record_id
    const taskId = newRecordId()
    const flowId = newRecordId()
    const stageId = newRecordId()
    const local = hosted(ids, {
      taskId,
      flowId,
      stageId,
      stageRevision: 3,
      workflow,
      workflowVersionId,
      activeOrdinal: 0,
      activeSlug: 'diagnose',
      totalSteps: 2,
    })
    const remote = hosted(ids, {
      taskId,
      flowId,
      stageId,
      stageRevision: 4,
      workflow,
      workflowVersionId,
      activeOrdinal: 1,
      activeSlug: 'fix-defect-fix',
      totalSteps: 2,
      closedStepNotes: [
        { n: 1, slug: 'diagnose', note: 'diagnosed remotely', at: '2026-11-03T10:30:00.000Z' },
      ],
    })
    cacheHostedTaskFlow(ids.database, 'DEV-2098', local)
    ids.database
      .query('UPDATE workflow_cursor SET task_record_id=NULL WHERE record_id=?')
      .run(stageId)
    installHosted(remote)
    const cursor = ids.database
      .query<{ number: number }, [string]>('SELECT number FROM workflow_cursor WHERE record_id=?')
      .get(stageId)!.number
    const selectedRow = selectWorkflowCursor(
      { project: 'read-through-fixture', workflow, mode: 'default' },
      cursor,
      null,
      ids.database,
    )!
    const context = await resolveWorkflowCursorContext(
      'read-through-fixture',
      callArgs,
      {},
      async () => [{ key: 'DEV-2098', record_id: taskId, project: 'read-through-fixture' }],
      selectedRow,
      ids.database,
    )
    resolveLinkedWorkflowCursorMode(
      workflow,
      'read-through-fixture',
      'default',
      callArgs,
      context,
      'test caller',
      'pass a mode',
      ids.database,
      selectedRow,
    )
    expect(
      ids.database
        .query('SELECT task_record_id FROM workflow_cursor WHERE record_id=?')
        .get(stageId),
    ).toEqual({ task_record_id: taskId })
    expect(
      ids.database
        .query('SELECT ordinal,revision FROM workflow_cursor WHERE record_id=?')
        .get(stageId),
    ).toEqual({ ordinal: 1, revision: 4 })

    const result = selectAndNextWorkflowStep(
      workflow,
      'read-through-fixture',
      'default',
      callArgs,
      'closed hosted step',
      context,
      ids.database,
      { artifact: 'task:DEV-2098' },
      {
        ...testPorts,
        readTask: () => ({
          recordId: taskId,
          key: 'DEV-2098',
          status: 'done',
          statusCategory: 'done',
          commentIds: [],
        }),
      },
      cursor,
    )

    expect(result).toContain('Took over this workflow stage from Machine B.')
    const closed = ids.database
      .query<{ ordinal: number; state: string; closed: string }, [string]>(
        'SELECT ordinal,state,closed FROM workflow_cursor WHERE record_id=?',
      )
      .get(stageId)!
    expect(closed).toMatchObject({ ordinal: 1, state: 'done' })
    expect(JSON.parse(closed.closed)).toContainEqual(
      expect.objectContaining({ slug: 'fix-defect-fix', note: 'closed hosted step' }),
    )
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
