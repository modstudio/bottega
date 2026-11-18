import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import { taskFlowRevisionRefusal } from './task-flow-store-sqlite-write.ts'
import type { TaskFlowIntentInput } from './task-flow-store-types.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'

const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
  d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
    '00000000-0000-4000-8000-000000000001',
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
})

async function stage(d: Database) {
  const composed = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    { key: 'DEV-2234', branch: 'DEV-2234-work', worktree: '/tmp/DEV-2234' },
    { session: 'session-one', taskRecordId: 'task-DEV-2234' },
    d,
    {},
    {},
  )
  return (await taskFlowReadStore(d).stageByHandle('fixture', composed.cursor!.id))!
}

test('intent writes refuse every stale expected revision', async () => {
  const d = database()
  const row = await stage(d)
  d.query('UPDATE workflow_cursor SET revision=2 WHERE record_id=?').run(row.record_id)
  const mutation = { id: row.record_id, expectedRevision: 1, values: { updatedAt: row.updated_at } }
  const cases = [
    ['compose', { requestId: row.record_id, stageChanges: [mutation] }],
    ['stage-update', { requestId: row.record_id, stages: [mutation] }],
    ['advance', { requestId: row.record_id, stage: mutation }],
    ['await-ruling', { requestId: row.record_id, stage: mutation }],
    ['abandon', { requestId: row.record_id, stage: mutation }],
    [
      'adopt',
      {
        requestId: row.record_id,
        stage: { id: row.record_id, expectedRevision: 1 },
        taskId: '00000000-0000-4000-8000-000000000002',
        updatedMachineId: '00000000-0000-4000-8000-000000000003',
        updatedAt: row.updated_at,
      },
    ],
  ] as const
  for (const [intent, payload] of cases)
    expect(() => taskFlowLocalStore(d).write(intent, payload as never)).toThrow('rerun the command')
})

test('intent writes use applied revisions and otherwise compute the next revision', async () => {
  const d = database()
  const row = await stage(d)
  const first: TaskFlowIntentInput<'stage-update'> = {
    requestId: row.record_id,
    stages: [{ id: row.record_id, expectedRevision: 1, values: { updatedAt: row.updated_at } }],
  }
  expect(
    taskFlowLocalStore(d).write('stage-update', first, { revisions: { [row.record_id]: 7 } })
      .revisions[row.record_id],
  ).toBe(7)
  expect(
    taskFlowLocalStore(d).write('stage-update', {
      ...first,
      stages: [{ ...first.stages[0]!, expectedRevision: 7 }],
    }).revisions[row.record_id],
  ).toBe(8)
})

test('local compose mints stage numbers independently per project', async () => {
  const d = database()
  const first = await stage(d)
  d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
    newRecordId(),
    'second-project',
    '/second-project',
    'bun',
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
  const otherProject = await composeWorkflowWithCursor(
    'flow',
    'second-project',
    'default',
    { key: 'DEV-2234-OTHER', branch: 'DEV-2234-other', worktree: '/tmp/DEV-2234-other' },
    { session: 'session-one', taskRecordId: 'task-DEV-2234-OTHER' },
    d,
    {},
    {},
  )
  const sameProject = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    { key: 'DEV-2234-B', branch: 'DEV-2234-B-work', worktree: '/tmp/DEV-2234-B' },
    { session: 'session-one', taskRecordId: 'task-DEV-2234-B' },
    d,
    {},
    {},
  )
  expect(first.id).toBe(1)
  expect(otherProject.cursor!.id).toBe(1)
  expect(sameProject.cursor!.id).toBe(2)
})

test('revision refusal names the declared intent and stale row kind', () => {
  const cases = [
    ['compose', 'flow', 'flow-id', 'task flow flow-id changed while composing'],
    ['compose', 'stage', 'stage-id', 'workflow stage stage-id changed while composing'],
    ['compose', 'cursor', 12, 'workflow cursor 12 changed while composing'],
    ['stage-update', 'cursor', 13, 'workflow cursor 13 changed while applying a stage update'],
    ['advance', 'flow', 'flow-id', 'task flow flow-id changed while advancing'],
    ['advance', 'cursor', 14, 'workflow cursor 14 changed while advancing'],
    ['await-ruling', 'cursor', 15, 'workflow cursor 15 changed while awaiting a ruling'],
    ['abandon', 'flow', 'flow-id', 'task flow flow-id changed while being abandoned'],
    ['abandon', 'cursor', 16, 'workflow cursor 16 changed while being abandoned'],
    ['handoff', 'flow', 'flow-id', 'task flow flow-id changed while being handed off'],
    ['handoff', 'cursor', 18, 'workflow cursor 18 changed while being handed off'],
    ['adopt', 'stage', 'stage-id', 'workflow stage stage-id changed while linking its task'],
    ['adopt', 'cursor', 17, 'workflow cursor 17 changed while linking its task'],
  ] as const
  for (const [intent, rowKind, identifier, expected] of cases)
    expect(taskFlowRevisionRefusal(intent, rowKind, identifier)).toBe(
      `${expected}; rerun the command`,
    )
})

test('handoff adopts the hosted successor id in the local mirror', async () => {
  const d = database()
  const row = await stage(d)
  const flow = d
    .query<{ revision: number }, [string]>('SELECT revision FROM task_flow WHERE record_id=?')
    .get(row.task_flow_record_id!)!
  const payloadId = newRecordId()
  const hostedId = newRecordId()
  const contextId = newRecordId()
  d.query(`INSERT INTO context_item
    (record_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at)
    VALUES (?,'cursor',?,'proof','fact','moves','test',?,?)`).run(
    contextId,
    row.record_id,
    row.created_at,
    row.updated_at,
  )
  const payload = {
    requestId: newRecordId(),
    flow: {
      id: row.task_flow_record_id!,
      expectedRevision: flow.revision,
      values: {
        openStageRecordId: payloadId,
        updatedMachineId: row.last_advanced_machine_id!,
        updatedAt: row.updated_at,
      },
    },
    oldStage: { id: row.record_id, expectedRevision: row.revision },
    newStage: {
      id: payloadId,
      flowRecordId: row.task_flow_record_id!,
      projectId: '00000000-0000-4000-8000-000000000001',
      workflow: row.workflow_slug,
      mode: row.mode_slug,
      workflowKey: row.workflow_key,
      instanceId: 'hosted-id-replay',
      sessionId: row.session_id,
      workflowVersionId: row.workflow_version_record_id,
      catalogueVersionId: row.catalogue_version_record_id,
      arguments: JSON.parse(row.args),
      activeOrdinal: 0,
      activeSlug: row.step_slug,
      state: 'running',
      closedStepNotes: [],
      question: null,
      autonomy: null,
      enforcement: 'floors',
      totalSteps: row.total_steps,
      openedMachineId: row.opened_machine_id,
      takenOverFromMachineId: null,
      lastAdvancedMachineId: row.last_advanced_machine_id,
      handedOffFromRecordId: row.record_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    trail: {
      closed: [],
      current: { n: 1, slug: row.step_slug },
      remaining: [],
      targetWorkflow: row.workflow_slug,
      reason: 'ready',
      at: row.updated_at,
    },
  }
  taskFlowLocalStore(d).write('handoff', payload as never, {
    revisions: { [row.record_id]: 2, [row.task_flow_record_id!]: 2, [hostedId]: 1 },
    stage: { id: hostedId, number: 2 },
  })
  expect(
    d.query<{ record_id: string }, [string]>(
      'SELECT record_id FROM workflow_cursor WHERE record_id=?',
    ).get(hostedId),
  ).toEqual({ record_id: hostedId })
  expect(
    d.query<{ record_id: string }, [string]>(
      'SELECT record_id FROM workflow_cursor WHERE record_id=?',
    ).get(payloadId),
  ).toBeNull()
  expect(
    d.query<{ open_stage_cursor_record_id: string }, [string]>(
      'SELECT open_stage_cursor_record_id FROM task_flow WHERE record_id=?',
    ).get(row.task_flow_record_id!),
  ).toEqual({ open_stage_cursor_record_id: hostedId })
  expect(
    d.query<{ holder_id: string }, [string]>('SELECT holder_id FROM context_item WHERE record_id=?')
      .get(contextId),
  ).toEqual({ holder_id: hostedId })
})

test('flow mutation preserves state when the payload omits it', async () => {
  const d = database()
  const row = await stage(d)
  const flow = d
    .query<{ record_id: string; revision: number }, [string]>(
      "UPDATE task_flow SET state='done' WHERE record_id=? RETURNING record_id,revision",
    )
    .get(row.task_flow_record_id!)!
  taskFlowLocalStore(d).write('stage-update', {
    requestId: row.record_id,
    flow: {
      id: flow.record_id,
      expectedRevision: flow.revision,
      values: {
        updatedMachineId: '00000000-0000-4000-8000-000000000003',
        updatedAt: row.updated_at,
      },
    },
    stages: [
      { id: row.record_id, expectedRevision: row.revision, values: { updatedAt: row.updated_at } },
    ],
  })
  expect(
    d
      .query<{ state: string }, [string]>('SELECT state FROM task_flow WHERE record_id=?')
      .get(flow.record_id)?.state,
  ).toBe('done')
})

test('stale adopt rows avoid partial mutation', async () => {
  const d = database()
  const row = await stage(d)
  d.query('UPDATE workflow_cursor SET revision=2 WHERE record_id=?').run(row.record_id)
  const before = d
    .query<
      { task_record_id: string | null; task_flow_record_id: string | null; revision: number },
      [string]
    >('SELECT task_record_id,task_flow_record_id,revision FROM workflow_cursor WHERE record_id=?')
    .get(row.record_id)!
  taskFlowLocalStore(d).write(
    'adopt',
    {
      requestId: row.record_id,
      stage: { id: row.record_id, expectedRevision: 3 },
      taskId: '00000000-0000-4000-8000-000000000099',
      updatedMachineId: '00000000-0000-4000-8000-000000000003',
      updatedAt: '2026-11-12T01:00:00.000Z',
    },
    {
      flowRecordId: row.task_flow_record_id!,
      revisions: { [row.record_id]: 4, [row.task_flow_record_id!]: 4 },
    },
  )
  expect(
    d
      .query(
        'SELECT task_record_id,task_flow_record_id,revision FROM workflow_cursor WHERE record_id=?',
      )
      .get(row.record_id),
  ).toEqual(before)
})
