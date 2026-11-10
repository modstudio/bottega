import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import type { TaskFlowIntentInput } from '../record/record-task-flow-write-contract.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { context, database } from './workflow-cursor-test.fixture.ts'

const hostedUrl = 'https://record.example.test'
let priorHostedUrl: string | undefined

beforeEach(() => {
  priorHostedUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = hostedUrl
})

afterEach(() => {
  if (priorHostedUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = priorHostedUrl
})

function composeClient(
  calls: TaskFlowIntentInput<'compose'>[],
  options: { fail?: Error; number?: number; flowRevision?: number; stageRevision?: number } = {},
): RecordTaskFlowClient {
  let replay:
    | { stage: { id: string; number: number }; revisions: Record<string, number> }
    | undefined
  return {
    composeTaskFlow: async (input) => {
      calls.push(input)
      if (options.fail) throw options.fail
      if (replay) return replay
      const stage = input.stageInsert!
      const flowId = input.flowInsert?.id ?? input.flowChange!.id
      replay = {
        stage: { id: stage.id, number: options.number ?? 41 },
        revisions: {
          [flowId]: options.flowRevision ?? 4,
          [stage.id]: options.stageRevision ?? 7,
        },
      }
      return replay
    },
  }
}

test('hosted compose runs first and caches its number and revisions without an outbox row', async () => {
  const d = database()
  const calls: TaskFlowIntentInput<'compose'>[] = []
  const taskFlowClient = composeClient(calls)

  const composed = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    { key: 'DEV-HOSTED', branch: 'DEV-HOSTED-work', worktree: '/tmp/hosted' },
    { ...context, taskRecordId: 'task-DEV-HOSTED', taskFlowClient },
    d,
    {},
    {},
  )

  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    flowInsert: { taskId: 'task-DEV-HOSTED' },
    stageInsert: { workflow: 'flow', workflowKey: 'DEV-HOSTED' },
  })
  expect(composed.cursor?.id).toBe(41)
  expect(
    d.query('SELECT number,revision FROM workflow_cursor WHERE workflow_key=?').get('DEV-HOSTED'),
  ).toEqual({ number: 41, revision: 7 })
  expect(
    d.query('SELECT revision FROM task_flow WHERE task_record_id=?').get('task-DEV-HOSTED'),
  ).toEqual({ revision: 4 })
  expect(d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%'").all()).toEqual([])
})

test('hosted compose failure leaves no local flow or cursor', async () => {
  const d = database()
  const calls: TaskFlowIntentInput<'compose'>[] = []
  const taskFlowClient = composeClient(calls, { fail: new Error('record unavailable; sign in') })

  await expect(
    composeWorkflowWithCursor(
      'flow',
      'fixture',
      'default',
      { key: 'DEV-FAIL', branch: 'DEV-FAIL-work', worktree: '/tmp/fail' },
      { ...context, taskRecordId: 'task-DEV-FAIL', taskFlowClient },
      d,
      {},
      {},
    ),
  ).rejects.toThrow('record unavailable; sign in')

  expect(calls).toHaveLength(1)
  expect(d.query("SELECT count(*) count FROM workflow_cursor WHERE workflow_key='DEV-FAIL'").get()).toEqual(
    { count: 0 },
  )
  expect(d.query("SELECT count(*) count FROM task_flow WHERE task_record_id='task-DEV-FAIL'").get()).toEqual(
    { count: 0 },
  )
})

test('compose replay after a local crash reuses its request id and hosted stage', async () => {
  const d = database()
  const calls: TaskFlowIntentInput<'compose'>[] = []
  const taskFlowClient = composeClient(calls, { number: 73 })
  d.exec(`CREATE TRIGGER fail_hosted_compose_cache BEFORE INSERT ON workflow_cursor
    WHEN NEW.workflow_key='DEV-REPLAY' BEGIN SELECT RAISE(ABORT, 'injected cache failure'); END`)
  const input = {
    slug: 'flow',
    project: 'fixture',
    mode: 'default',
    args: { key: 'DEV-REPLAY', branch: 'DEV-REPLAY-work', worktree: '/tmp/replay' },
    context: { ...context, taskRecordId: 'task-DEV-REPLAY', taskFlowClient },
  }

  await expect(
    composeWorkflowWithCursor(
      input.slug,
      input.project,
      input.mode,
      input.args,
      input.context,
      d,
      {},
      {},
    ),
  ).rejects.toThrow('injected cache failure')
  d.exec('DROP TRIGGER fail_hosted_compose_cache')
  const composed = await composeWorkflowWithCursor(
    input.slug,
    input.project,
    input.mode,
    input.args,
    input.context,
    d,
    {},
    {},
  )

  expect(calls).toHaveLength(2)
  expect(calls[1]!.requestId).toBe(calls[0]!.requestId)
  expect(composed.cursor?.id).toBe(73)
  expect(
    d.query('SELECT record_id FROM workflow_cursor WHERE workflow_key=?').get('DEV-REPLAY'),
  ).toEqual({ record_id: calls[0]!.stageInsert!.id })
})

test('local-only compose makes no client call and writes no task-flow outbox row', async () => {
  delete process.env.BOTTEGA_RECORD_API_URL
  const d = database()
  const calls: TaskFlowIntentInput<'compose'>[] = []
  const taskFlowClient = composeClient(calls)

  await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    { key: 'DEV-LOCAL', branch: 'DEV-LOCAL-work', worktree: '/tmp/local' },
    { ...context, taskRecordId: 'task-DEV-LOCAL', taskFlowClient },
    d,
    {},
    {},
  )

  expect(calls).toEqual([])
  expect(d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%'").all()).toEqual([])
})
