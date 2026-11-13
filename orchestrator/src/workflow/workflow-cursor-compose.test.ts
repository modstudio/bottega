import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { resolvedRecordOrigin } from '../../../shared/record-api-url.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { DocRevisionConflictError } from '../doc/doc-revision-conflict.ts'
import { rememberActiveRecordSpace } from '../project-space.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import {
  type TaskFlowIntentInput,
  taskFlowRequestId,
} from '../record/record-task-flow-write-contract.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { awaitWorkflowRuling, composeWorkflowWithCursor } from './workflow-cursor.ts'
import { adoptWorkflowTask } from './workflow-cursor-adoption.ts'
import { ruleWorkflow } from './workflow-cursor-ruling.ts'
import { linkWorkflowTaskLabel } from './workflow-task-linking.ts'
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

const destinationSpaceId = 'fixture-space'
const projectIdentityClient = {
  whoami: async () => ({
    user: { id: 'fixture-user' },
    activeSpaceId: destinationSpaceId,
    personalSpaceId: destinationSpaceId,
    memberships: [{ space_id: destinationSpaceId, slug: 'fixture-space', permission: 'write' }],
  }),
}
function hostedDatabase(): Database {
  const d = database()
  for (const table of [
    'workflow',
    'workflow_version',
    'step_catalogue',
    'step_catalogue_version',
  ]) {
    d.query(`UPDATE ${table} SET space_id = ?`).run(destinationSpaceId)
  }
  rememberActiveRecordSpace(d, destinationSpaceId)
  rememberProjectSpace(d, 'fixture', destinationSpaceId)
  d.query('INSERT INTO record_install_binding (id,bound_at,record_origin) VALUES (1,?,?)').run(
    '2026-11-10T00:00:00.000Z',
    resolvedRecordOrigin(),
  )
  return d
}

function composeClient(
  calls: TaskFlowIntentInput<'compose'>[],
  options: {
    fail?: Error
    number?: number
    flowRevision?: number
    stageRevision?: number
    enforcement?: string
    recordCompose?: boolean
    destinations?: Array<{ destinationSpaceId?: string } | undefined>
    projectNames?: Record<string, string>
  } = {},
): RecordTaskFlowClient {
  const memory = createMemoryRecordApiClient({
    taskFlowComposeFlowRevision: options.flowRevision ?? 4,
    taskFlowComposeStageRevision: options.stageRevision ?? 7,
    taskFlowComposeEnforcement: options.enforcement,
    taskFlowProjectNames: options.projectNames,
  })
  const replays = new Map<
    string,
    { stage: { id: string; number: number }; revisions: Record<string, number> }
  >()
  return {
    ...memory,
    ...projectIdentityClient,
    composeTaskFlow: async (input, destination) => {
      calls.push(input)
      options.destinations?.push(destination)
      if (options.fail) throw options.fail
      const replay = replays.get(input.requestId)
      if (replay) return replay
      const stored =
        options.recordCompose === false
          ? { stage: { id: input.stageInsert!.id, number: options.number ?? 41 } }
          : await memory.composeTaskFlow!(input, destination)
      const stage = input.stageInsert!
      const flowId = input.flowInsert?.id ?? input.flowChange!.id
      const result = {
        stage: { id: stage.id, number: options.number ?? stored.stage!.number },
        revisions: {
          [flowId]: options.flowRevision ?? 4,
          [stage.id]: options.stageRevision ?? 7,
        },
      }
      replays.set(input.requestId, result)
      return result
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
  d.query('UPDATE workflow SET space_id = ? WHERE slug = ?').run(destinationSpaceId, slug)
  d.query(
    'UPDATE workflow_version SET space_id = ? WHERE workflow_record_id = (SELECT record_id FROM workflow WHERE slug = ? AND space_id = ?)',
  ).run(destinationSpaceId, slug, destinationSpaceId)
}

test('hosted compose prints the hosted number while caching the machine-local number', async () => {
  const d = hostedDatabase()
  await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    { key: 'DEV-EXISTING', branch: 'DEV-EXISTING-work', worktree: '/tmp/existing' },
    {
      ...context,
      taskRecordId: 'task-DEV-EXISTING',
      taskFlowClient: composeClient([], { number: 99 }),
    },
    d,
    {},
    {},
  )
  const calls: TaskFlowIntentInput<'compose'>[] = []
  const destinations: Array<{ destinationSpaceId?: string } | undefined> = []
  const taskFlowClient = composeClient(calls, { destinations, number: 1 })

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
  expect(destinations).toEqual([{ destinationSpaceId }])
  expect(calls[0]).toMatchObject({
    flowInsert: { taskId: 'task-DEV-HOSTED' },
    stageInsert: { workflow: 'flow', workflowKey: 'DEV-HOSTED' },
  })
  expect(composed.cursor?.id).toBe(1)
  expect(
    d.query('SELECT number,revision FROM workflow_cursor WHERE workflow_key=?').get('DEV-HOSTED'),
  ).toEqual({ number: 2, revision: 7 })
  expect(
    d.query('SELECT revision FROM task_flow WHERE task_record_id=?').get('task-DEV-HOSTED'),
  ).toEqual({ revision: 4 })
  expect(d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%'").all()).toEqual([])
})

test('hosted stage update presents and refreshes the record row when the mirror is stale', async () => {
  const d = hostedDatabase()
  const calls: TaskFlowIntentInput<'compose'>[] = []
  const taskFlowClient = composeClient(calls)
  const args = { key: 'DEV-STALE', branch: 'DEV-STALE-work', worktree: '/tmp/stale' }
  const callContext = { ...context, taskRecordId: 'task-DEV-STALE', taskFlowClient }
  const opened = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    callContext,
    d,
    {},
    {},
  )
  d.query("UPDATE workflow_cursor SET revision=6,state='awaiting-ruling' WHERE number=?").run(
    opened.cursor!.id,
  )

  const resumed = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    callContext,
    d,
    {},
    {},
  )

  expect(resumed.cursor).toMatchObject({ state: 'running', opened: false })
  expect(
    d.query('SELECT revision,state FROM workflow_cursor WHERE number=?').get(opened.cursor!.id),
  ).toEqual({ revision: 8, state: 'running' })
})

test('task linking refreshes a stale adopted stage from the record', async () => {
  const d = hostedDatabase()
  const taskFlowClient = composeClient([])
  const workflowKey = 'DEV-ADOPT-REFRESH'
  const opened = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    { key: workflowKey, branch: 'DEV-ADOPT-work', worktree: '/tmp/adopt' },
    { ...context, taskRecordId: null, taskFlowClient },
    d,
    {},
    {},
  )
  const stage = d
    .query<{ record_id: string }, [number]>('SELECT record_id FROM workflow_cursor WHERE number=?')
    .get(opened.cursor!.id)!
  d.query('UPDATE workflow_cursor SET revision=6 WHERE record_id=?').run(stage.record_id)
  const hosted = await taskFlowClient.readTaskFlow!(
    { taskKey: workflowKey },
    { destinationSpaceId },
  )
  const taskRecordId = 'task-DEV-ADOPT-REFRESH'

  await linkWorkflowTaskLabel(d, { project: 'fixture', workflowKey, taskRecordId }, taskFlowClient)

  expect(
    d
      .query(
        'SELECT task_record_id,task_flow_record_id,revision FROM workflow_cursor WHERE record_id=?',
      )
      .get(stage.record_id),
  ).toEqual({
    task_record_id: taskRecordId,
    task_flow_record_id: hosted.flow.id,
    revision: 8,
  })
})

test('hosted compose prints and resolves the per-project number across two projects', async () => {
  const d = hostedDatabase()
  const secondProjectId = '00000000-0000-4000-8000-000000000099'
  const settings = d
    .query<{ settings: string }, []>("SELECT settings FROM project WHERE name='fixture'")
    .get()!.settings
  d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
    secondProjectId,
    'second-fixture',
    '/second-fixture',
    'bun',
    settings,
  )
  rememberProjectSpace(d, 'second-fixture', destinationSpaceId)
  const calls: TaskFlowIntentInput<'compose'>[] = []
  const taskFlowClient = composeClient(calls, {
    projectNames: {
      '00000000-0000-4000-8000-000000000001': 'fixture',
      [secondProjectId]: 'second-fixture',
    },
  })
  await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    { key: 'DEV-FIRST', branch: 'DEV-FIRST-work', worktree: '/tmp/first' },
    { ...context, taskRecordId: 'task-DEV-FIRST', taskFlowClient },
    d,
    {},
    {},
  )
  const second = await composeWorkflowWithCursor(
    'flow',
    'second-fixture',
    'default',
    { key: 'DEV-SECOND', branch: 'DEV-SECOND-work', worktree: '/tmp/second' },
    { ...context, taskRecordId: 'task-DEV-SECOND', taskFlowClient },
    d,
    {},
    {},
  )
  expect(second.cursor?.id).toBe(1)
  expect(
    d.query('SELECT number FROM workflow_cursor WHERE workflow_key=?').get('DEV-SECOND'),
  ).toEqual({ number: 2 })
  expect(
    await taskFlowReadStore(d, taskFlowClient).stageByHandle('second-fixture', 1),
  ).toMatchObject({ record_id: calls[1]!.stageInsert!.id, id: 1, project: 'second-fixture' })
})

test('hosted compose failure leaves no local flow or cursor', async () => {
  const d = hostedDatabase()
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
  expect(
    d.query("SELECT count(*) count FROM workflow_cursor WHERE workflow_key='DEV-FAIL'").get(),
  ).toEqual({ count: 0 })
  expect(
    d.query("SELECT count(*) count FROM task_flow WHERE task_record_id='task-DEV-FAIL'").get(),
  ).toEqual({ count: 0 })
})

test('compose replay after a local crash reuses its request id and hosted stage', async () => {
  const d = hostedDatabase()
  const calls: TaskFlowIntentInput<'compose'>[] = []
  const taskFlowClient = composeClient(calls, { number: 73, recordCompose: false })
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
  const d = hostedDatabase()
  const composeCalls: TaskFlowIntentInput<'compose'>[] = []
  const events: string[] = []
  let stageId = ''
  let flowId = ''
  const memory = composeClient(composeCalls, {
    stageRevision: 7,
    flowRevision: 4,
    enforcement: 'note-only',
  })
  const taskFlowClient: RecordTaskFlowClient = {
    ...memory,
    ...projectIdentityClient,
    advanceTaskFlow: async (input, destination) => {
      events.push('advance')
      expect(
        d.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(input.stage.id),
      ).toEqual({ revision: 7 })
      return memory.advanceTaskFlow!(input, destination)
    },
    awaitTaskFlowRuling: async (input, destination) => {
      events.push('await-ruling')
      expect(
        d.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(input.stage.id),
      ).toEqual({ revision: 8 })
      expect(
        d
          .query('SELECT count(*) count FROM question WHERE workflow_cursor_record_id=?')
          .get(input.stage.id),
      ).toEqual({ count: 0 })
      return memory.awaitTaskFlowRuling!(input, destination)
    },
    updateTaskFlowStage: async (input, destination) => {
      events.push('stage-update')
      expect(
        d.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(input.stages[0]!.id),
      ).toEqual({ revision: 9 })
      return memory.updateTaskFlowStage!(input, destination)
    },
    abandonTaskFlow: async (input, destination) => {
      events.push('abandon')
      expect(
        d.query('SELECT state,revision FROM workflow_cursor WHERE record_id=?').get(input.stage.id),
      ).toEqual({ state: 'running', revision: 10 })
      return memory.abandonTaskFlow!(input, destination)
    },
  }
  const hostedContext = { ...context, taskRecordId: 'task-DEV-LIFECYCLE', taskFlowClient }
  const args = { key: 'DEV-LIFECYCLE', branch: 'DEV-LIFECYCLE-work', worktree: '/tmp/lifecycle' }
  const opened = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    hostedContext,
    d,
    {},
    {},
  )
  stageId = d
    .query<{ record_id: string }, [number]>('SELECT record_id FROM workflow_cursor WHERE number=?')
    .get(opened.cursor!.id)!.record_id
  flowId = d
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM task_flow WHERE task_record_id=?',
    )
    .get(hostedContext.taskRecordId)!.record_id
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE record_id=?").run(stageId)

  await selectAndNextWorkflowStep(
    'flow',
    'fixture',
    'default',
    args,
    'advance',
    hostedContext,
    d,
    {},
    testPorts,
  )
  expect(d.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(stageId)).toEqual({
    revision: 8,
  })
  await awaitWorkflowRuling(
    'flow',
    'fixture',
    'default',
    args,
    'Proceed?',
    hostedContext,
    d,
    () => {},
  )
  expect(d.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(stageId)).toEqual({
    revision: 9,
  })
  await ruleWorkflow('flow', 'fixture', 'default', args, 'Proceed.', true, 'mcp', hostedContext, d)
  expect(d.query('SELECT revision FROM workflow_cursor WHERE record_id=?').get(stageId)).toEqual({
    revision: 10,
  })
  await abandonCursor('flow', 'fixture', 'default', args, 'finished', hostedContext, d)

  expect(events).toEqual(['advance', 'await-ruling', 'stage-update', 'abandon'])
  expect(
    d.query('SELECT state,revision FROM workflow_cursor WHERE record_id=?').get(stageId),
  ).toEqual({ state: 'abandoned', revision: 11 })
  expect(d.query('SELECT revision FROM task_flow WHERE record_id=?').get(flowId)).toEqual({
    revision: 5,
  })
})

test("abandoning a stage that is not its flow's open stage preserves the pointer", async () => {
  const d = hostedDatabase()
  let abandoned: TaskFlowIntentInput<'abandon'> | undefined
  let secondStageId = ''
  const memory = createMemoryRecordApiClient()
  const taskFlowClient: RecordTaskFlowClient = {
    ...memory,
    ...projectIdentityClient,
    composeTaskFlow: (input, destination) => memory.composeTaskFlow!(input, destination),
    abandonTaskFlow: async (input) => {
      abandoned = input
      return { revisions: { [input.stage.id]: 2 } }
    },
    readTaskFlow: async (selector, destination) => {
      const result = await memory.readTaskFlow!(selector, destination)
      return selector.flowRecordId && secondStageId
        ? { ...result, flow: { ...result.flow, openStageRecordId: secondStageId } }
        : result
    },
  }
  const firstContext = { ...context, taskRecordId: 'task-DEV-FIRST', taskFlowClient }
  const secondContext = { ...context, taskRecordId: 'task-DEV-SECOND', taskFlowClient }
  const firstArgs = { key: 'DEV-FIRST', branch: 'first', worktree: '/tmp/first' }
  const secondArgs = { key: 'DEV-SECOND', branch: 'second', worktree: '/tmp/second' }
  const first = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    firstArgs,
    firstContext,
    d,
    {},
    {},
  )
  const second = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    secondArgs,
    secondContext,
    d,
    {},
    {},
  )
  const firstStage = d
    .query<{ record_id: string; task_flow_record_id: string }, [number]>(
      'SELECT record_id,task_flow_record_id FROM workflow_cursor WHERE number=?',
    )
    .get(first.cursor!.id)!
  secondStageId = d
    .query<{ record_id: string }, [number]>('SELECT record_id FROM workflow_cursor WHERE number=?')
    .get(second.cursor!.id)!.record_id
  d.query('UPDATE task_flow SET open_stage_cursor_record_id=? WHERE record_id=?').run(
    secondStageId,
    firstStage.task_flow_record_id,
  )

  await abandonCursor(
    'flow',
    'fixture',
    'default',
    firstArgs,
    'superseded stage',
    firstContext,
    d,
    first.cursor!.id,
  )

  expect(abandoned?.flow).toBeUndefined()
  expect(
    d
      .query('SELECT open_stage_cursor_record_id,revision FROM task_flow WHERE record_id=?')
      .get(firstStage.task_flow_record_id),
  ).toEqual({ open_stage_cursor_record_id: secondStageId, revision: 1 })
})

test('adoption calls adopt then stage-update and caches the hosted flow identity', async () => {
  const d = hostedDatabase()
  installKeylessWorkflow(d, 'hosted-adoption')
  const events: string[] = []
  let hostedFlowId = ''
  const memory = createMemoryRecordApiClient()
  const taskFlowClient: RecordTaskFlowClient = {
    ...memory,
    ...projectIdentityClient,
    composeTaskFlow: async (input) => {
      hostedFlowId = input.flowInsert!.id
      await memory.composeTaskFlow!(input, { destinationSpaceId })
      return {
        stage: { id: input.stageInsert!.id, number: 81 },
        revisions: { [hostedFlowId]: 2, [input.stageInsert!.id]: 3 },
      }
    },
    adoptTaskFlow: async (input) => {
      events.push('adopt')
      expect(
        d.query('SELECT task_record_id FROM workflow_cursor WHERE record_id=?').get(input.stage.id),
      ).toEqual({ task_record_id: null })
      return { flowRecordId: hostedFlowId, revisions: { [hostedFlowId]: 5, [input.stage.id]: 6 } }
    },
    updateTaskFlowStage: async (input) => {
      events.push('stage-update')
      expect(input.stages[0]).toMatchObject({
        expectedRevision: 6,
        values: { workflowKey: 'DEV-ADOPTED' },
      })
      return { revisions: { [input.stages[0]!.id]: 7 } }
    },
  }
  await composeWorkflowWithCursor(
    'hosted-adoption',
    'fixture',
    'default',
    {},
    { session: 'adoption-session', taskFlowClient },
    d,
    {},
    {},
  )
  const row = d
    .query(
      `SELECT number id,record_id,project,workflow_slug,mode_slug,workflow_key,
            task_record_id,args,revision FROM workflow_cursor`,
    )
    .get() as Parameters<typeof adoptWorkflowTask>[0]

  await adoptWorkflowTask(row, 'DEV-ADOPTED', 'task-DEV-ADOPTED', d, taskFlowClient, 'active')

  expect(events).toEqual(['adopt', 'stage-update'])
  expect(
    d
      .query('SELECT record_id,revision FROM task_flow WHERE task_record_id=?')
      .get('task-DEV-ADOPTED'),
  ).toEqual({ record_id: hostedFlowId, revision: 5 })
  expect(d.query('SELECT task_flow_record_id,revision FROM workflow_cursor').get()).toEqual({
    task_flow_record_id: hostedFlowId,
    revision: 7,
  })
})

test('hosted text attach, copy, and delete happen before their local rows change', async () => {
  const d = hostedDatabase()
  const composeCalls: TaskFlowIntentInput<'compose'>[] = []
  const events: string[] = []
  const memory = composeClient(composeCalls)
  const taskFlowClient: RecordTaskFlowClient = {
    ...memory,
    ...projectIdentityClient,
    attachTaskFlowText: async (input, destination) => {
      events.push('attach-text')
      expect(
        d
          .query('SELECT count(*) count FROM workflow_step_text WHERE record_id=?')
          .get(input.rows[0]!.id),
      ).toEqual({ count: 0 })
      return memory.attachTaskFlowText!(input, destination)
    },
    copyTaskFlowText: async (input, destination) => {
      events.push('copy-text')
      expect(
        d
          .query('SELECT count(*) count FROM workflow_text_copy WHERE record_id=?')
          .get(input.row.id),
      ).toEqual({ count: 0 })
      return memory.copyTaskFlowText!(input, destination)
    },
    deleteTaskFlowText: async (input, destination) => {
      events.push('delete-text')
      expect(
        d
          .query('SELECT count(*) count FROM workflow_step_text WHERE record_id=?')
          .get(input.ids[0]!),
      ).toEqual({ count: 1 })
      return memory.deleteTaskFlowText!(input, destination)
    },
  }
  const hostedContext = { ...context, taskRecordId: 'task-DEV-TEXT', taskFlowClient }
  const textArgs = { key: 'DEV-TEXT', branch: 'DEV-TEXT-work', worktree: '/tmp/text' }
  const opened = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    textArgs,
    hostedContext,
    d,
    {},
    {},
  )
  const cursor = d
    .query<
      { recordId: string; number: number; project: string; taskRecordId: string; state: string },
      [number]
    >(
      `SELECT record_id recordId,number,project,task_record_id taskRecordId,state
       FROM workflow_cursor WHERE number=?`,
    )
    .get(opened.cursor!.id)!
  await attachWorkflowTextByHandle(cursor.number, 'hosted attachment', hostedContext, d)
  await copyWorkflowTextForCursor(
    cursor,
    d,
    async () => [
      { key: 'DEV-TEXT', record_id: cursor.taskRecordId, project: 'fixture', source: 'local' },
    ],
    { list: async () => [], create: async () => 'doc:hosted-text' },
    taskFlowClient,
  )
  await deleteWorkflowText(cursor.recordId, true, d, taskFlowClient)

  expect(events).toEqual(['attach-text', 'copy-text', 'delete-text'])
  expect(
    d
      .query('SELECT count(*) count FROM workflow_step_text WHERE cursor_record_id=?')
      .get(cursor.recordId),
  ).toEqual({ count: 0 })
})

test('keyless hosted composes use distinct deterministic session slots', async () => {
  const d = hostedDatabase()
  installKeylessWorkflow(d, 'hosted-keyless-slots')
  const calls: TaskFlowIntentInput<'compose'>[] = []
  const memory = createMemoryRecordApiClient()
  const taskFlowClient: RecordTaskFlowClient = {
    ...memory,
    ...projectIdentityClient,
    composeTaskFlow: async (input) => {
      calls.push(input)
      return memory.composeTaskFlow!(input, { destinationSpaceId })
    },
  }
  const hostedContext = { session: 'shared-keyless-session', taskFlowClient }

  await composeWorkflowWithCursor(
    'hosted-keyless-slots',
    'fixture',
    'default',
    {},
    hostedContext,
    d,
    {},
    {},
  )
  await composeWorkflowWithCursor(
    'hosted-keyless-slots',
    'fixture',
    'default',
    {},
    hostedContext,
    d,
    {},
    {},
  )

  expect(calls).toHaveLength(2)
  expect(calls[0]!.stageInsert!.instanceId).not.toBe(calls[1]!.stageInsert!.instanceId)
  expect(calls[0]!.requestId).not.toBe(calls[1]!.requestId)
  expect(d.query('SELECT instance_id FROM workflow_cursor ORDER BY number').all()).toEqual([
    { instance_id: calls[0]!.stageInsert!.instanceId },
    { instance_id: calls[1]!.stageInsert!.instanceId },
  ])
})

test('keyless compose after a cache crash advances past the hosted slot', async () => {
  const d = hostedDatabase()
  installKeylessWorkflow(d, 'hosted-keyless-replay')
  const calls: TaskFlowIntentInput<'compose'>[] = []
  const taskFlowClient = composeClient(calls, { number: 101 })
  d.exec(`CREATE TRIGGER fail_keyless_cache BEFORE INSERT ON workflow_cursor
    WHEN NEW.workflow_slug='hosted-keyless-replay'
    BEGIN SELECT RAISE(ABORT, 'injected keyless cache failure'); END`)
  const hostedContext = { session: 'keyless-replay-session', taskFlowClient }

  await expect(
    composeWorkflowWithCursor(
      'hosted-keyless-replay',
      'fixture',
      'default',
      {},
      hostedContext,
      d,
      {},
      {},
    ),
  ).rejects.toThrow('injected keyless cache failure')
  d.exec('DROP TRIGGER fail_keyless_cache')
  await composeWorkflowWithCursor(
    'hosted-keyless-replay',
    'fixture',
    'default',
    {},
    hostedContext,
    d,
    {},
    {},
  )

  expect(calls).toHaveLength(2)
  expect(calls[1]!.requestId).not.toBe(calls[0]!.requestId)
  expect(calls[1]!.stageInsert!.instanceId).not.toBe(calls[0]!.stageInsert!.instanceId)
  expect(d.query('SELECT number,instance_id FROM workflow_cursor').get()).toEqual({
    number: 1,
    instance_id: calls[1]!.stageInsert!.instanceId,
  })
})

test('keyless open-slot recovery recounts once and composes the next sibling slot', async () => {
  const d = hostedDatabase()
  installKeylessWorkflow(d, 'hosted-keyless-sibling')
  const composeCalls: TaskFlowIntentInput<'compose'>[] = []
  let setupStageId = ''
  let setupFlowId = ''
  let listCalls = 0
  const memory = createMemoryRecordApiClient()
  const taskFlowClient: RecordTaskFlowClient = {
    ...memory,
    ...projectIdentityClient,
    composeTaskFlow: async (input) => {
      if (!setupStageId) {
        setupStageId = input.stageInsert!.id
        setupFlowId = input.flowInsert!.id
        return memory.composeTaskFlow!(input, { destinationSpaceId })
      }
      composeCalls.push(input)
      if (composeCalls.length === 1)
        throw new DocRevisionConflictError(
          'the keyless slot already exists',
          'task_flow_stage_open_slot_unique',
          'already-exists',
          null,
        )
      return {
        stage: { id: input.stageInsert!.id, number: 203 },
        revisions: { [input.flowInsert!.id]: 1, [input.stageInsert!.id]: 1 },
      }
    },
    listTaskFlowStages: async (selector, destination) => {
      if (!composeCalls.length || selector.workflow)
        return memory.listTaskFlowStages!(selector, destination)
      listCalls += 1
      const failed = composeCalls[0]!.stageInsert!
      return {
        truncated: false,
        nextCursor: null,
        items: [
          {
            stage: {
              ...failed,
              id: setupStageId,
              number: 201,
              projectName: 'fixture',
              workflowKey: null,
              workflowVersionNumber: 1,
              catalogueVersionNumber: 1,
              revision: 1,
            },
            flow: {
              id: setupFlowId,
              projectId: failed.projectId,
              taskId: null,
              taskKey: null,
              state: 'open',
              openStageRecordId: setupStageId,
              openStageCount: 1,
              openingMachineId: failed.openedMachineId,
              updatedMachineId: failed.lastAdvancedMachineId,
              revision: 1,
              createdAt: failed.createdAt,
              updatedAt: failed.updatedAt,
            },
          },
        ],
      }
    },
  }
  const hostedContext = { session: 'keyless-sibling-session', taskFlowClient }
  await composeWorkflowWithCursor(
    'hosted-keyless-sibling',
    'fixture',
    'default',
    {},
    hostedContext,
    d,
    {},
    {},
  )
  await composeWorkflowWithCursor(
    'hosted-keyless-sibling',
    'fixture',
    'default',
    {},
    hostedContext,
    d,
    {},
    {},
  )

  expect(listCalls).toBe(1)
  expect(composeCalls).toHaveLength(2)
  expect(composeCalls[1]!.stageInsert!.instanceId).not.toBe(
    composeCalls[0]!.stageInsert!.instanceId,
  )
  expect(composeCalls[1]!.requestId).toBe(
    taskFlowRequestId('compose', [
      composeCalls[1]!.stageInsert!.projectId,
      'hosted-keyless-sibling',
      'default',
      '',
      composeCalls[1]!.stageInsert!.instanceId ?? '',
    ]),
  )
})
