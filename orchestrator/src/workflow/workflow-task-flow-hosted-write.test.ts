import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import type { TaskFlowIntentInput } from '../record/record-task-flow-write-contract.ts'
import { adoptWorkflowTask } from './workflow-cursor-adoption.ts'
import {
  awaitWorkflowRuling,
  composeWorkflowWithCursor,
  ruleWorkflow,
} from './workflow-cursor.ts'
import {
  abandonCursor,
  context,
  database,
  selectAndNextWorkflowStep,
  testPorts,
} from './workflow-cursor-test.fixture.ts'
import { attachWorkflowTextByHandle, deleteWorkflowText } from './workflow-text.ts'
import { copyWorkflowTextForCursor } from './workflow-text-copy.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

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

function installKeylessWorkflow(d: Database, slug: string): void {
  const draft = setWorkflowLocal(
    slug,
    {
      title: `${slug} fixture`,
      description: 'Exercises hosted keyless task-flow slots.',
      arguments: [{ name: 'key', required: false, description: 'Task key.' }],
      modes: [{ slug: 'default', title: 'Default', default: true, steps: ['score', 'complete'] }],
    },
    'hosted task-flow fixture',
    'test',
    d,
  )
  promoteWorkflowLocal(slug, draft.n, 'publish hosted task-flow fixture', 'test', d)
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

test('advance, await, rule, and abandon call the record before caching returned revisions', async () => {
  const d = database()
  const composeCalls: TaskFlowIntentInput<'compose'>[] = []
  const events: string[] = []
  let stageId = ''
  let flowId = ''
  const taskFlowClient: RecordTaskFlowClient = {
    ...composeClient(composeCalls, { stageRevision: 7, flowRevision: 4 }),
    advanceTaskFlow: async (input) => {
      events.push('advance')
      expect(d.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(input.stage.id)).toEqual({ revision: 7 })
      return { revisions: { [input.stage.id]: 11, ...(input.flow ? { [input.flow.id]: 6 } : {}) } }
    },
    awaitTaskFlowRuling: async (input) => {
      events.push('await-ruling')
      expect(d.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(input.stage.id)).toEqual({ revision: 11 })
      expect(d.query('SELECT count(*) count FROM question WHERE workflow_cursor_record_id=?').get(input.stage.id)).toEqual({ count: 0 })
      return { revisions: { [input.stage.id]: 12 } }
    },
    updateTaskFlowStage: async (input) => {
      events.push('stage-update')
      expect(d.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(input.stages[0]!.id)).toEqual({ revision: 12 })
      return { revisions: { [input.stages[0]!.id]: 13 } }
    },
    abandonTaskFlow: async (input) => {
      events.push('abandon')
      expect(d.query('SELECT state,revision FROM workflow_cursor WHERE record_id=?').get(input.stage.id)).toEqual({ state: 'running', revision: 13 })
      return { revisions: { [input.stage.id]: 14, ...(input.flow ? { [input.flow.id]: 8 } : {}) } }
    },
  }
  const hostedContext = { ...context, taskRecordId: 'task-DEV-LIFECYCLE', taskFlowClient }
  const args = { key: 'DEV-LIFECYCLE', branch: 'DEV-LIFECYCLE-work', worktree: '/tmp/lifecycle' }
  const opened = await composeWorkflowWithCursor('flow', 'fixture', 'default', args, hostedContext, d, {}, {})
  stageId = d.query<{ record_id: string }, [number]>('SELECT record_id FROM workflow_cursor WHERE number=?').get(opened.cursor!.id)!.record_id
  flowId = d.query<{ record_id: string }, [string]>('SELECT record_id FROM task_flow WHERE task_record_id=?').get(hostedContext.taskRecordId)!.record_id
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE record_id=?").run(stageId)

  await selectAndNextWorkflowStep('flow', 'fixture', 'default', args, 'advance', hostedContext, d, {}, testPorts)
  expect(d.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(stageId)).toEqual({ revision: 11 })
  await awaitWorkflowRuling('flow', 'fixture', 'default', args, 'Proceed?', hostedContext, d, () => {})
  expect(d.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(stageId)).toEqual({ revision: 12 })
  await ruleWorkflow('flow', 'fixture', 'default', args, 'Proceed.', true, 'mcp', hostedContext, d)
  expect(d.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(stageId)).toEqual({ revision: 13 })
  await abandonCursor('flow', 'fixture', 'default', args, 'finished', hostedContext, d)

  expect(events).toEqual(['advance', 'await-ruling', 'stage-update', 'abandon'])
  expect(d.query('SELECT state,revision FROM workflow_cursor WHERE record_id=?').get(stageId)).toEqual({ state: 'abandoned', revision: 14 })
  expect(d.query('SELECT revision FROM task_flow WHERE record_id=?').get(flowId)).toEqual({ revision: 8 })
})

test('adoption calls adopt then stage-update and caches the hosted flow identity', async () => {
  const d = database()
  installKeylessWorkflow(d, 'hosted-adoption')
  const events: string[] = []
  let hostedFlowId = ''
  const taskFlowClient: RecordTaskFlowClient = {
    composeTaskFlow: async (input) => {
      hostedFlowId = input.flowInsert!.id
      return { stage: { id: input.stageInsert!.id, number: 81 }, revisions: { [hostedFlowId]: 2, [input.stageInsert!.id]: 3 } }
    },
    adoptTaskFlow: async (input) => {
      events.push('adopt')
      expect(d.query('SELECT task_record_id FROM workflow_cursor WHERE record_id=?').get(input.stage.id)).toEqual({ task_record_id: null })
      return { flowRecordId: hostedFlowId, revisions: { [hostedFlowId]: 5, [input.stage.id]: 6 } }
    },
    updateTaskFlowStage: async (input) => {
      events.push('stage-update')
      expect(input.stages[0]).toMatchObject({ expectedRevision: 6, values: { workflowKey: 'DEV-ADOPTED' } })
      return { revisions: { [input.stages[0]!.id]: 7 } }
    },
  }
  await composeWorkflowWithCursor('hosted-adoption', 'fixture', 'default', {}, { session: 'adoption-session', taskFlowClient }, d, {}, {})
  const row = d.query(
    `SELECT number id,record_id,project,workflow_slug,mode_slug,workflow_key,
            task_record_id,args,revision FROM workflow_cursor`,
  ).get() as Parameters<typeof adoptWorkflowTask>[0]

  await adoptWorkflowTask(row, 'DEV-ADOPTED', 'task-DEV-ADOPTED', d, taskFlowClient, 'active')

  expect(events).toEqual(['adopt', 'stage-update'])
  expect(d.query('SELECT record_id,revision FROM task_flow WHERE task_record_id=?').get('task-DEV-ADOPTED')).toEqual({ record_id: hostedFlowId, revision: 5 })
  expect(d.query('SELECT task_flow_record_id,revision FROM workflow_cursor').get()).toEqual({ task_flow_record_id: hostedFlowId, revision: 7 })
})

test('hosted text attach, copy, and delete happen before their local rows change', async () => {
  const d = database()
  const composeCalls: TaskFlowIntentInput<'compose'>[] = []
  const events: string[] = []
  const taskFlowClient: RecordTaskFlowClient = {
    ...composeClient(composeCalls),
    attachTaskFlowText: async (input) => {
      events.push('attach-text')
      expect(d.query('SELECT count(*) count FROM workflow_step_text WHERE record_id=?').get(input.rows[0]!.id)).toEqual({ count: 0 })
      return { revisions: {} }
    },
    copyTaskFlowText: async (input) => {
      events.push('copy-text')
      expect(d.query('SELECT count(*) count FROM workflow_text_copy WHERE record_id=?').get(input.row.id)).toEqual({ count: 0 })
      return { revisions: {} }
    },
    deleteTaskFlowText: async (input) => {
      events.push('delete-text')
      expect(d.query('SELECT count(*) count FROM workflow_step_text WHERE record_id=?').get(input.ids[0]!)).toEqual({ count: 1 })
      return { revisions: {} }
    },
  }
  const hostedContext = { ...context, taskRecordId: 'task-DEV-TEXT', taskFlowClient }
  const textArgs = { key: 'DEV-TEXT', branch: 'DEV-TEXT-work', worktree: '/tmp/text' }
  const opened = await composeWorkflowWithCursor('flow', 'fixture', 'default', textArgs, hostedContext, d, {}, {})
  const cursor = d.query<{ recordId: string; number: number; project: string; taskRecordId: string; state: string }, [number]>(
    `SELECT record_id recordId,number,project,task_record_id taskRecordId,state
       FROM workflow_cursor WHERE number=?`,
  ).get(opened.cursor!.id)!
  await attachWorkflowTextByHandle(cursor.number, 'hosted attachment', hostedContext, d)
  await copyWorkflowTextForCursor(
    cursor,
    d,
    async () => [{ key: 'DEV-TEXT', record_id: cursor.taskRecordId, project: 'fixture', source: 'local' }],
    { list: async () => [], create: async () => 'doc:hosted-text' },
    taskFlowClient,
  )
  await deleteWorkflowText(cursor.recordId, true, d, taskFlowClient)

  expect(events).toEqual(['attach-text', 'copy-text', 'delete-text'])
  expect(d.query('SELECT count(*) count FROM workflow_step_text WHERE cursor_record_id=?').get(cursor.recordId)).toEqual({ count: 0 })
})

test('keyless hosted composes use distinct deterministic session slots', async () => {
  const d = database()
  installKeylessWorkflow(d, 'hosted-keyless-slots')
  const calls: TaskFlowIntentInput<'compose'>[] = []
  const taskFlowClient: RecordTaskFlowClient = {
    composeTaskFlow: async (input) => {
      calls.push(input)
      const number = 90 + calls.length
      return {
        stage: { id: input.stageInsert!.id, number },
        revisions: { [input.flowInsert!.id]: 2, [input.stageInsert!.id]: 3 },
      }
    },
  }
  const hostedContext = { session: 'shared-keyless-session', taskFlowClient }

  await composeWorkflowWithCursor('hosted-keyless-slots', 'fixture', 'default', {}, hostedContext, d, {}, {})
  await composeWorkflowWithCursor('hosted-keyless-slots', 'fixture', 'default', {}, hostedContext, d, {}, {})

  expect(calls).toHaveLength(2)
  expect(calls[0]!.stageInsert!.instanceId).not.toBe(calls[1]!.stageInsert!.instanceId)
  expect(calls[0]!.requestId).not.toBe(calls[1]!.requestId)
  expect(d.query('SELECT instance_id FROM workflow_cursor ORDER BY number').all()).toEqual([
    { instance_id: calls[0]!.stageInsert!.instanceId },
    { instance_id: calls[1]!.stageInsert!.instanceId },
  ])
})

test('keyless compose crash recovery reuses the same request and instance slot', async () => {
  const d = database()
  installKeylessWorkflow(d, 'hosted-keyless-replay')
  const calls: TaskFlowIntentInput<'compose'>[] = []
  const taskFlowClient = composeClient(calls, { number: 101 })
  d.exec(`CREATE TRIGGER fail_keyless_cache BEFORE INSERT ON workflow_cursor
    WHEN NEW.workflow_slug='hosted-keyless-replay'
    BEGIN SELECT RAISE(ABORT, 'injected keyless cache failure'); END`)
  const hostedContext = { session: 'keyless-replay-session', taskFlowClient }

  await expect(
    composeWorkflowWithCursor('hosted-keyless-replay', 'fixture', 'default', {}, hostedContext, d, {}, {}),
  ).rejects.toThrow('injected keyless cache failure')
  d.exec('DROP TRIGGER fail_keyless_cache')
  await composeWorkflowWithCursor('hosted-keyless-replay', 'fixture', 'default', {}, hostedContext, d, {}, {})

  expect(calls).toHaveLength(2)
  expect(calls[1]!.requestId).toBe(calls[0]!.requestId)
  expect(calls[1]!.stageInsert!.instanceId).toBe(calls[0]!.stageInsert!.instanceId)
  expect(d.query('SELECT number,instance_id FROM workflow_cursor').get()).toEqual({
    number: 101,
    instance_id: calls[0]!.stageInsert!.instanceId,
  })
})
