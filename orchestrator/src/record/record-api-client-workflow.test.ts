import { expect, test } from 'bun:test'
import { RecordApiRequestError } from './record-api-client-response.ts'
import { recordTaskFlowClient } from './record-api-client-task-flow.ts'
import { recordWorkflowClient } from './record-api-client-workflow.ts'
import type { RecordWorkflowImportInput } from './record-workflow-contract.ts'

const input: RecordWorkflowImportInput = {
  dryRun: false,
  step_catalogue: [],
  step_catalogue_version: [],
  step_catalogue_event: [],
  workflow: [],
  workflow_version: [],
  workflow_event: [],
}

test('workflow imports use only the reconciled v2 route', async () => {
  const paths: string[] = []
  const client = recordWorkflowClient(async (path) => {
    paths.push(path)
    return { inserted: 0, alreadyPresent: 0, skipped: [], outcomes: [] } as never
  })
  await client.importWorkflowCatalogue!(input)
  expect(paths).toEqual(['/v1/workflow-catalogue/import/v2'])
})

test.each([404, 405])('workflow import refuses an old record API response %s', async (status) => {
  const client = recordWorkflowClient(async () => {
    throw { status }
  })
  await expect(client.importWorkflowCatalogue!(input)).rejects.toThrow(
    'record API predates reconciled workflow import; release hosted-api, then retry',
  )
})

test.each([404, 405])('task-flow write refuses an old record API response %s', async (status) => {
  const client = recordTaskFlowClient(async () => {
    throw { status }
  })
  await expect(
    client.deleteTaskFlowText!({
      requestId: '00000000-0000-4000-8000-000000000001',
      stageRecordId: '00000000-0000-4000-8000-000000000002',
      ids: ['00000000-0000-4000-8000-000000000003'],
    }),
  ).rejects.toThrow('record API predates task-flow writes; release hosted-api, then retry')
})

test('task-flow stage lists carry combined filters and the destination space', async () => {
  const requests: Array<{
    path: string
    destinationSpaceId?: string
  }> = []
  const client = recordTaskFlowClient(async (path, init) => {
    requests.push({ path, destinationSpaceId: init?.destinationSpaceId })
    return { items: [], truncated: false } as never
  })
  await client.listTaskFlowStages!(
    {
      projectId: '00000000-0000-4000-8000-000000000001',
      number: 4,
      states: ['running', 'awaiting-ruling'],
      limit: 50,
    },
    { destinationSpaceId: '00000000-0000-4000-8000-000000000002' },
  )
  expect(requests).toEqual([
    {
      path: '/v1/task-flow/stages?projectId=00000000-0000-4000-8000-000000000001&number=4&state=running&state=awaiting-ruling&limit=50',
      destinationSpaceId: '00000000-0000-4000-8000-000000000002',
    },
  ])
})

const ID = '00000000-0000-4000-8000-000000000010'
const STAGE_ID = '00000000-0000-4000-8000-000000000011'
const FLOW_ID = '00000000-0000-4000-8000-000000000012'
const PROJECT_ID = '00000000-0000-4000-8000-000000000013'
const VERSION_ID = '00000000-0000-4000-8000-000000000014'
const CATALOGUE_ID = '00000000-0000-4000-8000-000000000015'
const MACHINE_ID = '00000000-0000-4000-8000-000000000016'
const TEXT_ID = '00000000-0000-4000-8000-000000000017'
const COPY_ID = '00000000-0000-4000-8000-000000000018'
const STAMP = '2026-11-11T12:00:00.000Z'

const stage = {
  id: STAGE_ID,
  flowRecordId: FLOW_ID,
  projectId: PROJECT_ID,
  projectName: 'project',
  number: 7,
  workflow: 'delivery',
  mode: 'default',
  workflowKey: 'DEV-2234',
  instanceId: 'instance',
  sessionId: 'session',
  workflowVersionId: VERSION_ID,
  workflowVersionNumber: 2,
  catalogueVersionId: CATALOGUE_ID,
  catalogueVersionNumber: 3,
  arguments: { task: 'DEV-2234' },
  activeOrdinal: 1,
  activeSlug: 'build',
  state: 'running' as const,
  closedStepNotes: [],
  question: null,
  autonomy: 'agent',
  enforcement: 'required',
  totalSteps: 4,
  openedMachineId: MACHINE_ID,
  takenOverFromMachineId: null,
  lastAdvancedMachineId: MACHINE_ID,
  revision: 5,
  createdAt: STAMP,
  updatedAt: STAMP,
  obligations: [],
  stepTexts: [],
  textCopies: [],
}
const flow = {
  id: FLOW_ID,
  projectId: PROJECT_ID,
  taskId: null,
  taskKey: 'DEV-2234',
  state: 'open' as const,
  openStageRecordId: STAGE_ID,
  openStageCount: 1,
  openingMachineId: MACHINE_ID,
  updatedMachineId: MACHINE_ID,
  revision: 5,
  createdAt: STAMP,
  updatedAt: STAMP,
}
const text = {
  id: TEXT_ID,
  stageRecordId: STAGE_ID,
  stepOrdinal: 2,
  stepSlug: 'build',
  body: 'evidence',
  createdAt: STAMP,
}
const copy = {
  id: COPY_ID,
  workflowTextRecordId: TEXT_ID,
  stageRecordId: STAGE_ID,
  taskDocumentReference: 'task:DEV-2234#comment-1',
  copiedAt: STAMP,
}
const obligation = {
  id: ID,
  stageRecordId: STAGE_ID,
  stepOrdinal: 2,
  stepSlug: 'build',
  floor: 'test',
  requirePullRequest: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  floorDeferrable: true,
  reason: 'required',
  sessionId: 'session',
  createdAt: STAMP,
  satisfiedAt: null,
  satisfiedStepOrdinal: null,
  satisfiedStepSlug: null,
  satisfiedEvidence: null,
  abandonedAt: null,
  abandonedReason: null,
  operatorRuling: false,
}

test('task-flow by-id clients return the validated stage, text and obligation shapes', async () => {
  const bodies = new Map([
    [`/v1/task-flow/stages/${ID}`, { stage, flow }],
    [`/v1/task-flow/texts/${ID}`, { text, stage: { id: STAGE_ID, number: 7 }, copy }],
    [
      `/v1/task-flow/obligations/${ID}`,
      { obligation, stage: { id: STAGE_ID, number: 7, state: 'running' } },
    ],
  ])
  const client = recordTaskFlowClient(async (path, init) => init!.schema!(bodies.get(path)))
  await expect(client.readTaskFlowStage!(ID)).resolves.toEqual({ stage, flow })
  await expect(client.readTaskFlowText!(ID)).resolves.toEqual({
    text,
    stage: { id: STAGE_ID, number: 7 },
    copy,
  })
  await expect(client.readTaskFlowObligation!(ID)).resolves.toEqual({
    obligation,
    stage: { id: STAGE_ID, number: 7, state: 'running' },
  })
})

test.each(['readTaskFlowStage', 'readTaskFlowText', 'readTaskFlowObligation'] as const)(
  '%s returns null for the record ordinary not-found response',
  async (method) => {
    const client = recordTaskFlowClient(async () => {
      throw new RecordApiRequestError(
        'hosted task flow was not found',
        'refused',
        404,
        'task_flow_not_found',
      )
    })
    await expect(client[method]!(ID)).resolves.toBeNull()
  },
)

test('task-flow by-id clients do not hide an unrelated not-found response', async () => {
  const client = recordTaskFlowClient(async () => {
    throw new RecordApiRequestError('route not found', 'refused', 404)
  })
  await expect(client.readTaskFlowStage!(ID)).rejects.toThrow('route not found')
})
