import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerRecordWorkflowRoutes } from './record-api-workflow.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  TASK_FLOW_STAGE_LIST_LIMIT_MAX,
  type TaskFlowStageListQuery,
} from './record-task-flow-contract.ts'

const SPACE = '00000000-0000-4000-8000-000000000001'
const PROJECT = '00000000-0000-4000-8000-000000000002'

function taskFlowApp(calls: TaskFlowStageListQuery[]) {
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  registerRecordWorkflowRoutes(
    app,
    {
      listTaskFlowStages: async (input) => {
        calls.push(input)
        return { items: [], truncated: false }
      },
      listWorkflowCatalogue: async () => [],
      draftWorkflow: async () => null,
      promoteWorkflow: async () => null,
      retireWorkflow: async () => null,
    },
    {
      scope: () => ({ url: 'postgres://unused', userId: SPACE, spaceId: SPACE, spaceIds: [SPACE] }),
      noSpace: () => new Response(null, { status: 403 }),
    },
  )
  return app
}

test('task-flow stage list validates combined filters and applies its default limit', async () => {
  const calls: TaskFlowStageListQuery[] = []
  const response = await taskFlowApp(calls).request(
    `/v1/task-flow/stages?projectId=${PROJECT}&number=7&state=running&state=awaiting-ruling`,
  )
  expect(response.status).toBe(200)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    projectId: PROJECT,
    number: 7,
    states: ['running', 'awaiting-ruling'],
    limit: 200,
  })
})

test.each(['', '?number=2', '?taskKey=DEV-2234&limit=0', '?taskKey=DEV-2234&limit=1001'])(
  'task-flow stage list refuses invalid query %s with the filter remedy',
  async (query) => {
    const calls: TaskFlowStageListQuery[] = []
    const response = await taskFlowApp(calls).request(`/v1/task-flow/stages${query}`)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'invalid task-flow stage list query',
      remedy: expect.stringContaining('projectId'),
    })
    expect(calls).toEqual([])
  },
)

test.each([1, TASK_FLOW_STAGE_LIST_LIMIT_MAX])(
  'task-flow stage list accepts limit bound %s',
  async (limit) => {
    const calls: TaskFlowStageListQuery[] = []
    const response = await taskFlowApp(calls).request(
      `/v1/task-flow/stages?sessionId=session-a&limit=${limit}`,
    )
    expect(response.status).toBe(200)
    expect(calls[0]).toMatchObject({ sessionId: 'session-a', limit })
  },
)
