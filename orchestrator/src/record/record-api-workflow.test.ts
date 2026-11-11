import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerRecordWorkflowRoutes } from './record-api-workflow.ts'
import type { RecordIdentity } from './record-auth.ts'
import { RecordTaskFlowError } from './record-task-flow.ts'
import {
  TASK_FLOW_STAGE_LIST_LIMIT_MAX,
  type TaskFlowStageListQuery,
} from './record-task-flow-contract.ts'

const SPACE = '00000000-0000-4000-8000-000000000001'
const PROJECT = '00000000-0000-4000-8000-000000000002'
const KNOWN_ID = '00000000-0000-4000-8000-000000000003'
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000004'

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

type ByIdKind = 'stage' | 'text' | 'obligation'
const byIdRoutes = [
  ['stage', '/v1/task-flow/stages'],
  ['text', '/v1/task-flow/texts'],
  ['obligation', '/v1/task-flow/obligations'],
] as const

function taskFlowByIdApp(
  spaceId: string,
  calls: Array<{ kind: ByIdKind; id: string; spaceId: string }>,
) {
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  const read = async (kind: ByIdKind, input: { id: string; spaceId: string }) => {
    calls.push({ kind, id: input.id, spaceId: input.spaceId })
    if (input.id !== KNOWN_ID || input.spaceId !== SPACE)
      throw new RecordTaskFlowError('hosted task flow was not found')
    return { kind, id: input.id, spaceId: input.spaceId }
  }
  registerRecordWorkflowRoutes(
    app,
    {
      readTaskFlowStage: (input) => read('stage', input),
      readTaskFlowText: (input) => read('text', input),
      readTaskFlowObligation: (input) => read('obligation', input),
      listWorkflowCatalogue: async () => [],
      draftWorkflow: async () => null,
      promoteWorkflow: async () => null,
      retireWorkflow: async () => null,
    },
    {
      scope: () => ({ url: 'postgres://unused', userId: SPACE, spaceId, spaceIds: [spaceId] }),
      noSpace: () => new Response(null, { status: 403 }),
    },
  )
  return app
}

test('task-flow by-id routes pass the active space and requested id to their dependencies', async () => {
  const calls: Array<{ kind: ByIdKind; id: string; spaceId: string }> = []
  const app = taskFlowByIdApp(SPACE, calls)
  for (const [, path] of byIdRoutes) await app.request(`${path}/${KNOWN_ID}`)
  expect(calls).toEqual([
    { kind: 'stage', id: KNOWN_ID, spaceId: SPACE },
    { kind: 'text', id: KNOWN_ID, spaceId: SPACE },
    { kind: 'obligation', id: KNOWN_ID, spaceId: SPACE },
  ])
})

test.each(byIdRoutes)(
  'task-flow %s by-id route returns the ordinary not-found shape for an unknown id',
  async (_kind, path) => {
    const response = await taskFlowByIdApp(SPACE, []).request(`${path}/${UNKNOWN_ID}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'hosted task flow was not found',
      code: 'task_flow_not_found',
    })
  },
)
