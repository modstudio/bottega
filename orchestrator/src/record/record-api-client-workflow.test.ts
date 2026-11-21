import { expect, test } from 'bun:test'
import { recordApiError } from './record-api-client-error.ts'
import { recordTaskFlowClient } from './record-api-client-task-flow.ts'
import { recordWorkflowClient } from './record-api-client-workflow.ts'
import { recordKeyedNotVisibleRefusal } from './record-keyed-read.ts'
import {
  RECORD_TASK_FLOW_NOT_FOUND_CODE,
  TASK_FLOW_OPEN_STAGE_STATES,
} from './record-task-flow-contract.ts'
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
const destination = { destinationSpaceId: 'workflow-space' }

test('workflow imports use only the reconciled v2 route', async () => {
  const paths: string[] = []
  const client = recordWorkflowClient(async (path) => {
    paths.push(path)
    return { inserted: 0, alreadyPresent: 0, skipped: [], outcomes: [] } as never
  })
  await client.importWorkflowCatalogue!(input, destination)
  expect(paths).toEqual(['/v1/workflow-catalogue/import/v2'])
})

test.each([404, 405])('workflow import refuses an old record API response %s', async (status) => {
  const client = recordWorkflowClient(async () => {
    throw { status }
  })
  await expect(client.importWorkflowCatalogue!(input, destination)).rejects.toThrow(
    'record API predates reconciled workflow import; release hosted-api, then retry',
  )
})

test.each([404, 405])('task-flow write refuses an old record API response %s', async (status) => {
  const client = recordTaskFlowClient(async () => {
    throw { status }
  })
  await expect(
    client.deleteTaskFlowText!(
      {
        requestId: '00000000-0000-4000-8000-000000000001',
        stageRecordId: '00000000-0000-4000-8000-000000000002',
        ids: ['00000000-0000-4000-8000-000000000003'],
      },
      destination,
    ),
  ).rejects.toThrow('record API predates task-flow writes; release hosted-api, then retry')
})

test('history imports post to their intent routes in the named destination space', async () => {
  const requests: Array<{ path: string; method?: string; destination?: string }> = []
  const client = recordWorkflowClient(async (path, init) => {
    requests.push({
      path,
      method: init?.method,
      destination: init?.destinationSpaceId,
    })
    return path === '/v1/task-flow/import'
      ? ({ revisions: {}, stages: [] } as never)
      : ({ id: ID, number: 7, revision: 1, applied: true } as never)
  })
  await client.importTaskFlow!(
    { requestId: ID, flow: { id: ID }, stages: [] } as never,
    destination,
  )
  await client.importQuestion!(
    { requestId: ID, question: { id: ID }, audits: [] } as never,
    destination,
  )
  expect(requests).toEqual([
    { path: '/v1/task-flow/import', method: 'POST', destination: 'workflow-space' },
    { path: '/v1/questions/import', method: 'POST', destination: 'workflow-space' },
  ])
})

test('task-flow stage lists carry combined filters and the destination space', async () => {
  const requests: Array<{
    path: string
    destinationSpaceId?: string
  }> = []
  const client = recordTaskFlowClient(async (path, init) => {
    requests.push({ path, destinationSpaceId: init?.destinationSpaceId })
    return { items: [], truncated: false, nextCursor: null } as never
  })
  await client.listTaskFlowStages!(
    {
      projectId: '00000000-0000-4000-8000-000000000001',
      number: 4,
      states: [...TASK_FLOW_OPEN_STAGE_STATES],
      linked: true,
      openedMachineId: '00000000-0000-4000-8000-000000000003',
      limit: 50,
    },
    { destinationSpaceId: '00000000-0000-4000-8000-000000000002' },
  )
  expect(requests).toEqual([
    {
      path: '/v1/task-flow/stages?projectId=00000000-0000-4000-8000-000000000001&openedMachineId=00000000-0000-4000-8000-000000000003&number=4&state=running&state=awaiting-ruling&linked=true&limit=50',
      destinationSpaceId: '00000000-0000-4000-8000-000000000002',
    },
  ])
})

test('task-flow presence posts every id batch without requiring a destination space', async () => {
  const requests: Array<{
    path: string
    method?: string
    body?: string
    destinationSpaceId?: string
  }> = []
  const client = recordTaskFlowClient(async (path, init) => {
    requests.push({
      path,
      method: init?.method,
      body: init?.body as string | undefined,
      destinationSpaceId: init?.destinationSpaceId,
    })
    const body = {
      flowIds: [ID],
      stageIds: [],
      obligationIds: [],
      textIds: [],
      textCopyIds: [],
      questionIds: [],
      questionAuditIds: [],
    }
    return (init?.schema ? init.schema(body) : body) as never
  })
  const input = {
    flowIds: [ID],
    stageIds: [],
    obligationIds: [],
    textIds: [],
    textCopyIds: [],
    questionIds: [],
    questionAuditIds: [],
  }
  await expect(client.readTaskFlowPresence!(input)).resolves.toEqual({
    ...input,
    questionAuditIdentities: [],
  })
  expect(requests).toEqual([
    {
      path: '/v1/task-flow/presence',
      method: 'POST',
      body: JSON.stringify(input),
      destinationSpaceId: undefined,
    },
  ])
})

test('task-flow stage summaries refuse an old server and preserve other refusals', async () => {
  const oldServer = recordApiError({ error: 'route not found' }, 404)
  const oldClient = recordTaskFlowClient(async () => {
    throw oldServer
  })
  await expect(oldClient.readTaskFlowStageSummaries!({ stageIds: [ID] })).rejects.toThrow(
    'route not found; deploy the hosted API with `scripts/deploy/hosted api`, then retry',
  )

  const badRequest = recordApiError({ error: 'invalid stage ids' }, 400)
  const currentClient = recordTaskFlowClient(async () => {
    throw badRequest
  })
  await expect(currentClient.readTaskFlowStageSummaries!({ stageIds: [ID] })).rejects.toBe(
    badRequest,
  )
})

const ID = '00000000-0000-4000-8000-000000000010'
test.each([
  ['keyed not-visible', recordKeyedNotVisibleRefusal(5)],
  [
    'ordinary not-found',
    { error: 'hosted task flow was not found', code: RECORD_TASK_FLOW_NOT_FOUND_CODE },
  ],
])('task-flow by-id clients return null for the %s response', async (_name, body) => {
  const paths: string[] = []
  const client = recordTaskFlowClient(async (path) => {
    paths.push(path)
    throw recordApiError(body, 404)
  })
  for (const method of [
    'readTaskFlowStage',
    'readTaskFlowText',
    'readTaskFlowObligation',
  ] as const) {
    await expect(client[method]!(ID)).resolves.toBeNull()
  }
  expect(paths).toEqual([
    `/v1/task-flow/stages/${ID}`,
    `/v1/task-flow/texts/${ID}`,
    `/v1/task-flow/obligations/${ID}`,
  ])
})

test('task-flow by-id clients do not hide an unrelated not-found response', async () => {
  const client = recordTaskFlowClient(async () => {
    throw recordApiError({ error: 'route not found', code: 'route_not_found' }, 404)
  })
  await expect(client.readTaskFlowStage!(ID)).rejects.toThrow('route not found')
})
