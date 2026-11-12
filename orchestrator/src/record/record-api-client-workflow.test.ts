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
test('task-flow by-id clients return null for the record ordinary not-found response', async () => {
  const paths: string[] = []
  const client = recordTaskFlowClient(async (path) => {
    paths.push(path)
    throw new RecordApiRequestError(
      'hosted task flow was not found',
      'refused',
      404,
      'task_flow_not_found',
    )
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
    throw new RecordApiRequestError('route not found', 'refused', 404)
  })
  await expect(client.readTaskFlowStage!(ID)).rejects.toThrow('route not found')
})
