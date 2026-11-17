import type { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { resolvedRecordOrigin } from '../../../shared/record-api-url.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { DocRevisionConflictError } from '../doc/doc-revision-conflict.ts'
import { rememberActiveRecordSpace } from '../project-space.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import {
  type TaskFlowIntentInput,
  taskFlowRequestId,
} from '../record/record-task-flow-write-contract.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { context, database } from './workflow-cursor-test.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

const destinationSpaceId = 'fixture-space'
const TASK_IDS = {
  existing: '00000000-0000-4000-8001-000000000001',
  hosted: '00000000-0000-4000-8001-000000000002',
  stale: '00000000-0000-4000-8001-000000000003',
  adoptRefresh: '00000000-0000-4000-8001-000000000004',
  advanceRefresh: '00000000-0000-4000-8001-000000000005',
  first: '00000000-0000-4000-8001-000000000006',
  second: '00000000-0000-4000-8001-000000000007',
  fail: '00000000-0000-4000-8001-000000000008',
  replay: '00000000-0000-4000-8001-000000000009',
  local: '00000000-0000-4000-8001-000000000010',
  lifecycle: '00000000-0000-4000-8001-000000000011',
  adopted: '00000000-0000-4000-8001-000000000012',
  text: '00000000-0000-4000-8001-000000000013',
} as const
const projectIdentityClient = {
  whoami: async () => ({
    user: { id: 'fixture-user' },
    activeSpaceId: destinationSpaceId,
    personalSpaceId: destinationSpaceId,
    memberships: [{ space_id: destinationSpaceId, slug: 'fixture-space', permission: 'write' }],
  }),
}
afterEach(() => installRecordApiClient(null))
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
): RecordApiClient {
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

test('hosted compose prints the hosted number without a local task-flow copy', async () => {
  const d = hostedDatabase()
  await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    { key: 'DEV-EXISTING', branch: 'DEV-EXISTING-work', worktree: '/tmp/existing' },
    {
      ...context,
      taskRecordId: TASK_IDS.existing,
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
    { ...context, taskRecordId: TASK_IDS.hosted, taskFlowClient },
    d,
    {},
    {},
  )

  expect(calls).toHaveLength(1)
  expect(destinations).toEqual([{ destinationSpaceId }])
  expect(calls[0]).toMatchObject({
    flowInsert: { taskId: TASK_IDS.hosted },
    stageInsert: { workflow: 'flow', workflowKey: 'DEV-HOSTED' },
  })
  expect(composed.cursor?.id).toBe(1)
  expect(d.query('SELECT 1 FROM workflow_cursor WHERE workflow_key=?').get('DEV-HOSTED')).toBeNull()
  expect(d.query('SELECT 1 FROM task_flow WHERE task_record_id=?').get(TASK_IDS.hosted)).toBeNull()
  expect(d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%'").all()).toEqual([])
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
    { ...context, taskRecordId: TASK_IDS.first, taskFlowClient },
    d,
    {},
    {},
  )
  const second = await composeWorkflowWithCursor(
    'flow',
    'second-fixture',
    'default',
    { key: 'DEV-SECOND', branch: 'DEV-SECOND-work', worktree: '/tmp/second' },
    { ...context, taskRecordId: TASK_IDS.second, taskFlowClient },
    d,
    {},
    {},
  )
  expect(second.cursor?.id).toBe(1)
  expect(d.query('SELECT 1 FROM workflow_cursor WHERE workflow_key=?').get('DEV-SECOND')).toBeNull()
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
      { ...context, taskRecordId: TASK_IDS.fail, taskFlowClient },
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
    d.query('SELECT count(*) count FROM task_flow WHERE task_record_id=?').get(TASK_IDS.fail),
  ).toEqual({ count: 0 })
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
    { ...context, taskRecordId: TASK_IDS.local, taskFlowClient },
    d,
    {},
    {},
  )

  expect(calls).toEqual([])
  expect(d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%'").all()).toEqual([])
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
  expect(d.query('SELECT instance_id FROM workflow_cursor ORDER BY number').all()).toEqual([])
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
