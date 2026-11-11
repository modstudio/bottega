import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import type { TaskFlowIntentInput } from '../record/record-task-flow-write-contract.ts'
import { taskFlowStore } from './task-flow-store.ts'
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
  return taskFlowStore(d).stageByHandle(composed.cursor!.id)!
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
    expect(() => taskFlowStore(d).write(intent, payload as never)).toThrow('rerun the command')
})

test('intent writes use applied revisions and otherwise compute the next revision', async () => {
  const d = database()
  const row = await stage(d)
  const first: TaskFlowIntentInput<'stage-update'> = {
    requestId: row.record_id,
    stages: [{ id: row.record_id, expectedRevision: 1, values: { updatedAt: row.updated_at } }],
  }
  expect(
    taskFlowStore(d).write('stage-update', first, { revisions: { [row.record_id]: 7 } }).revisions[
      row.record_id
    ],
  ).toBe(7)
  expect(
    taskFlowStore(d).write('stage-update', {
      ...first,
      stages: [{ ...first.stages[0]!, expectedRevision: 7 }],
    }).revisions[row.record_id],
  ).toBe(8)
})

test('local compose returns the machine-wide number it minted', async () => {
  const d = database()
  const first = await stage(d)
  const second = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    { key: 'DEV-2234-B', branch: 'DEV-2234-B-work', worktree: '/tmp/DEV-2234-B' },
    { session: 'session-one', taskRecordId: 'task-DEV-2234-B' },
    d,
    {},
    {},
  )
  expect(second.cursor!.id).toBe(first.id + 1)
})
