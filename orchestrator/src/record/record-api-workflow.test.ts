import { expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { idleRecordApiDeps, idleSubjectDeps } from '../../test/fixtures/record-api.ts'
import { recordApiTestApp } from '../../test/fixtures/record-api-app.ts'
import { identity } from './record-api-identity.fixture.ts'
import { registerRecordWorkflowRoutes } from './record-api-workflow.ts'
import type { RecordIdentity } from './record-auth.ts'
import { RECORD_KEYED_NOT_VISIBLE_CODE } from './record-keyed-read.ts'
import { RecordTaskFlowError } from './record-task-flow.ts'
import {
  TASK_FLOW_OPEN_STAGE_STATES,
  TASK_FLOW_PRESENCE_BATCH_MAX,
  TASK_FLOW_STAGE_LIST_LIMIT_MAX,
  TASK_FLOW_STAGE_LIST_WORKFLOW_KEYS_MAX,
  TASK_FLOW_STAGE_SUMMARY_BATCH_MAX,
  type TaskFlowPresence,
  type TaskFlowStageListQuery,
} from './record-task-flow-contract.ts'

const SPACE = '00000000-0000-4000-8000-000000000001'
const PROJECT = '00000000-0000-4000-8000-000000000002'
const KNOWN_ID = '00000000-0000-4000-8000-000000000003'
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000004'

const recordApiAppWith = (overrides: Record<string, unknown>) =>
  recordApiTestApp(
    {
      ...identity,
      memberships: [
        ...identity.memberships,
        { space_id: 'space-b', name: 'Space B', slug: 'space-b' },
      ],
    },
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    overrides,
  )

function taskFlowApp(calls: TaskFlowStageListQuery[]) {
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  registerRecordWorkflowRoutes(
    app,
    {
      listTaskFlowStages: async (input) => {
        calls.push(input)
        return { items: [], truncated: false, nextCursor: null }
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
    states: TASK_FLOW_OPEN_STAGE_STATES,
    limit: 200,
  })
})

test('task-flow stage list accepts summary only alongside a real filter', async () => {
  const calls: TaskFlowStageListQuery[] = []
  const summaryOnly = await taskFlowApp(calls).request('/v1/task-flow/stages?view=summary')
  expect(summaryOnly.status).toBe(400)
  const filtered = await taskFlowApp(calls).request(
    `/v1/task-flow/stages?projectId=${PROJECT}&view=summary`,
  )
  expect(filtered.status).toBe(200)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ projectId: PROJECT, view: 'summary' })
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

test('task-flow presence defaults omitted batches and validates every named batch limit', async () => {
  const calls: Array<
    TaskFlowPresence & {
      url: string
      userId: string
      spaceId: string
      spaceIds: string[]
    }
  > = []
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  registerRecordWorkflowRoutes(
    app,
    {
      readTaskFlowPresence: async (input) => {
        calls.push(input)
        return input
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
  const response = await app.request('/v1/task-flow/presence', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flowIds: [KNOWN_ID], stageIds: [UNKNOWN_ID] }),
  })
  expect(response.status).toBe(200)
  expect(calls).toEqual([
    {
      flowIds: [KNOWN_ID],
      stageIds: [UNKNOWN_ID],
      obligationIds: [],
      textIds: [],
      textCopyIds: [],
      questionIds: [],
      questionAuditIds: [],
      url: 'postgres://unused',
      userId: SPACE,
      spaceId: SPACE,
      spaceIds: [SPACE],
    },
  ])
  for (const field of [
    'stageIds',
    'flowIds',
    'obligationIds',
    'textIds',
    'textCopyIds',
    'questionIds',
    'questionAuditIds',
  ] as const) {
    const oversized = await app.request('/v1/task-flow/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        [field]: Array(TASK_FLOW_PRESENCE_BATCH_MAX + 1).fill(KNOWN_ID),
      }),
    })
    expect(oversized.status).toBe(400)
    expect(await oversized.json()).toEqual({ error: 'invalid task-flow presence request' })
  }
  const unknown = await app.request('/v1/task-flow/presence', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flowIds: [], stageIds: [], extraIds: [] }),
  })
  expect(unknown.status).toBe(400)
  expect(await unknown.json()).toEqual({ error: 'invalid task-flow presence request' })
})

test('destinationless task-flow presence reads every member space without write telemetry', async () => {
  const flowId = '01990000-0000-7000-8000-000000000011'
  const stageId = '01990000-0000-7000-8000-000000000012'
  const recorded = mock(async () => undefined)
  const app = recordApiAppWith({
    noDestinationWriteCounter: {
      record: recorded,
      read: async () => ({ windowStart: '', unrecorded: 0, counts: [] }),
    },
    readTaskFlowPresence: async (input: {
      flowIds: string[]
      stageIds: string[]
      spaceIds: string[]
    }) => ({
      flowIds: input.spaceIds.includes('space-a') ? input.flowIds : [],
      stageIds: input.spaceIds.includes('space-b') ? input.stageIds : [],
      obligationIds: [],
      textIds: [],
      textCopyIds: [],
      questionIds: [],
      questionAuditIds: [],
    }),
  })

  const response = await app.request('/v1/task-flow/presence', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flowIds: [flowId], stageIds: [stageId] }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    flowIds: [flowId],
    stageIds: [stageId],
    obligationIds: [],
    textIds: [],
    textCopyIds: [],
    questionIds: [],
    questionAuditIds: [],
  })
  expect(recorded).not.toHaveBeenCalled()
})

test('task-flow stage summaries validate bounds, scope the read, and omit missing ids and text bodies', async () => {
  const calls: Array<{ stageIds: string[]; spaceId: string; uuidKeyedRead?: true }> = []
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  registerRecordWorkflowRoutes(
    app,
    {
      readTaskFlowStageSummaries: async (input) => {
        calls.push(input)
        return {
          items: input.stageIds.includes(KNOWN_ID)
            ? [{ stage: { id: KNOWN_ID, number: 7, obligations: [] }, flow: { id: PROJECT } }]
            : [],
        }
      },
      listWorkflowCatalogue: async () => [],
      draftWorkflow: async () => null,
      promoteWorkflow: async () => null,
      retireWorkflow: async () => null,
    },
    {
      scope: () => ({
        url: 'postgres://unused',
        userId: SPACE,
        spaceId: SPACE,
        spaceIds: [SPACE],
        uuidKeyedRead: true,
      }),
      noSpace: () => new Response(null, { status: 403 }),
    },
  )
  const response = await app.request('/v1/task-flow/stage-summaries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stageIds: [KNOWN_ID, UNKNOWN_ID] }),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { items: Array<{ stage: Record<string, unknown> }> }
  expect(body.items).toHaveLength(1)
  expect(body.items[0]?.stage).not.toHaveProperty('stepTexts')
  expect(body.items[0]?.stage).not.toHaveProperty('textCopies')
  expect(calls).toEqual([
    expect.objectContaining({
      stageIds: [KNOWN_ID, UNKNOWN_ID],
      spaceId: SPACE,
      uuidKeyedRead: true,
    }),
  ])

  const oversized = await app.request('/v1/task-flow/stage-summaries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stageIds: Array(TASK_FLOW_STAGE_SUMMARY_BATCH_MAX + 1).fill(KNOWN_ID),
    }),
  })
  expect(oversized.status).toBe(400)
  expect(calls).toHaveLength(1)
})

test('task-flow stage list refuses contradictory task-link filters', async () => {
  const calls: TaskFlowStageListQuery[] = []
  const response = await taskFlowApp(calls).request(
    '/v1/task-flow/stages?linked=true&unlinked=true',
  )
  expect(response.status).toBe(400)
  expect(calls).toEqual([])
  expect(await response.json()).toEqual({
    error: 'invalid task-flow stage list query',
    remedy: expect.stringContaining('linked'),
  })
})

test('task-flow stage list passes the hosted filters and ordering', async () => {
  const calls: TaskFlowStageListQuery[] = []
  const response = await taskFlowApp(calls).request(
    `/v1/task-flow/stages?projectId=${PROJECT}&state=running&workflow=fix-defect&mode=default&workflowKey=DEV-2234&workflowKeys=DEV-2234&workflowKeys=DEV-2235&keyless=true&primaryInstance=true&taskId=${KNOWN_ID}&linked=true&openedMachineId=${UNKNOWN_ID}&order=newest`,
  )
  expect(response.status).toBe(200)
  expect(calls[0]).toMatchObject({
    workflow: 'fix-defect',
    mode: 'default',
    workflowKey: 'DEV-2234',
    workflowKeys: ['DEV-2234', 'DEV-2235'],
    projectId: PROJECT,
    states: ['running'],
    keyless: true,
    primaryInstance: true,
    taskId: KNOWN_ID,
    linked: true,
    openedMachineId: UNKNOWN_ID,
    order: 'newest',
  })
})

test('task-flow stage list refuses more than the workflow-key batch maximum', async () => {
  const calls: TaskFlowStageListQuery[] = []
  const query = new URLSearchParams({ projectId: PROJECT })
  for (let index = 0; index <= TASK_FLOW_STAGE_LIST_WORKFLOW_KEYS_MAX; index++)
    query.append('workflowKeys', `DEV-${index}`)
  const response = await taskFlowApp(calls).request(`/v1/task-flow/stages?${query}`)
  expect(response.status).toBe(400)
  expect(calls).toEqual([])
})

test('task-flow stage list without workflowKeys preserves the existing query', async () => {
  const calls: TaskFlowStageListQuery[] = []
  const response = await taskFlowApp(calls).request(`/v1/task-flow/stages?projectId=${PROJECT}`)
  expect(response.status).toBe(200)
  expect(calls[0]?.workflowKeys).toBeUndefined()
})

type ByIdKind = 'stage' | 'text' | 'obligation'
const byIdRoutes = [
  ['stage', '/v1/task-flow/stages'],
  ['text', '/v1/task-flow/texts'],
  ['obligation', '/v1/task-flow/obligations'],
] as const

function taskFlowByIdApp(
  spaceId: string,
  calls: Array<{ kind: ByIdKind; id: string; spaceId: string }>,
  destination = false,
) {
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  if (destination)
    app.use('*', async (context, next) => {
      context.set('destinationSpaceId', spaceId)
      await next()
    })
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
      scope: () => ({
        url: 'postgres://unused',
        userId: SPACE,
        spaceId,
        spaceIds: [spaceId],
        ...(!destination ? { uuidKeyedRead: true as const } : {}),
      }),
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
  'task-flow %s by-id route returns the membership-safe refusal for an unknown id',
  async (_kind, path) => {
    const response = await taskFlowByIdApp(SPACE, []).request(`${path}/${UNKNOWN_ID}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'not visible in your record spaces (1 memberships)',
      remedy:
        'the row is in a space you are not a member of, or it does not exist; join its space or check the id',
      code: RECORD_KEYED_NOT_VISIBLE_CODE,
    })
  },
)

test('a task-flow by-id read with a named destination keeps the existing miss response', async () => {
  const response = await taskFlowByIdApp(SPACE, [], true).request(
    `/v1/task-flow/stages/${UNKNOWN_ID}`,
  )
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    error: 'hosted task flow was not found',
    code: 'task_flow_not_found',
  })
})

test('a destinationless flow-record-id miss returns the membership-safe refusal', async () => {
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  registerRecordWorkflowRoutes(
    app,
    {
      readTaskFlow: async () => {
        throw new RecordTaskFlowError('hosted task flow was not found')
      },
      listWorkflowCatalogue: async () => [],
      draftWorkflow: async () => null,
      promoteWorkflow: async () => null,
      retireWorkflow: async () => null,
    },
    {
      scope: () => ({
        url: 'postgres://unused',
        userId: SPACE,
        spaceId: SPACE,
        spaceIds: [SPACE, PROJECT],
        uuidKeyedRead: true,
      }),
      noSpace: () => new Response(null, { status: 403 }),
    },
  )
  const response = await app.request(`/v1/task-flow?flowRecordId=${UNKNOWN_ID}`)
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    error: 'not visible in your record spaces (2 memberships)',
    remedy:
      'the row is in a space you are not a member of, or it does not exist; join its space or check the id',
    code: RECORD_KEYED_NOT_VISIBLE_CODE,
  })
})
