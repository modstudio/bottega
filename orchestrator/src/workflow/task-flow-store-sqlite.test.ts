import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  type TASK_FLOW_CLOSED_STAGE_STATES,
  TASK_FLOW_STAGE_STATES,
} from '../record/record-task-flow-contract.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { listWorkflowCursors } from './workflow-cursor-list.ts'
import { database } from './workflow-cursor-test.fixture.ts'

test('all-state stage reads include closed cursors without widening open reads', async () => {
  const d = database()
  d.query(
    `INSERT INTO project (record_id,name,path,stack,settings)
     SELECT ?,'other','/tmp/other',stack,settings FROM project WHERE name='fixture'`,
  ).run(newRecordId())

  const composeClosed = async (
    project: string,
    key: string,
    session: string,
    state: (typeof TASK_FLOW_CLOSED_STAGE_STATES)[number],
  ) => {
    const composed = await composeWorkflowWithCursor(
      'flow',
      project,
      'default',
      { key, branch: `${key}-work`, worktree: `/tmp/${key}` },
      { session, taskRecordId: `task-${key}` },
      d,
      {},
      {},
    )
    d.query('UPDATE workflow_cursor SET state=? WHERE number=?').run(state, composed.cursor!.id)
  }

  await composeClosed('fixture', 'DEV-DONE', 'session-done', 'done')
  await composeClosed('fixture', 'DEV-ABANDONED', 'session-abandoned', 'abandoned')
  await composeClosed('other', 'DEV-OTHER', 'session-other', 'done')
  await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    { key: 'DEV-OPEN', branch: 'DEV-OPEN-work', worktree: '/tmp/DEV-OPEN' },
    { session: 'session-open', taskRecordId: 'task-DEV-OPEN' },
    d,
    {},
    {},
  )
  d.query("UPDATE workflow_cursor SET args=? WHERE workflow_key='DEV-DONE'").run(
    JSON.stringify({
      key: 'DEV-DONE',
      branch: 'DEV-DONE-work',
      worktree: '/tmp/DEV-DONE',
      request: 'an argument the recorded workflow version does not declare',
    }),
  )

  const store = taskFlowReadStore(d)
  expect(
    (await store.listStages({ project: 'fixture', states: TASK_FLOW_STAGE_STATES }))
      .map((row) => ({ state: row.state, question: row.question_number }))
      .sort((left, right) => left.state.localeCompare(right.state)),
  ).toEqual([
    { state: 'abandoned', question: null },
    { state: 'done', question: null },
    { state: 'running', question: null },
  ])
  expect(
    (await store.listOpenStages({ project: 'fixture' })).map((row) => row.workflow_key),
  ).toEqual(['DEV-OPEN'])
  expect(
    (
      await store.listStages({
        project: 'fixture',
        workflowKeys: ['DEV-DONE', 'DEV-OPEN'],
        states: TASK_FLOW_STAGE_STATES,
      })
    ).map((row) => row.workflow_key),
  ).toEqual(['DEV-DONE', 'DEV-OPEN'])
  expect(
    await store.listStages({
      project: 'fixture',
      workflowKeys: [],
      states: TASK_FLOW_STAGE_STATES,
    }),
  ).toEqual([])
  const open = (await store.listOpenStages({ project: 'fixture' }))[0]!
  expect(await store.stageSummaries([open.record_id, newRecordId()])).toEqual([
    { stage: expect.objectContaining({ record_id: open.record_id }), obligations: [] },
  ])

  const cursorCount = d.query<{ count: number }, []>('SELECT count(*) count FROM workflow_cursor')
  const listed = await listWorkflowCursors({ all: true, project: 'fixture' }, d)
  expect(
    listed
      .map((row) => ({
        state: row.state,
        next: row.next_slug,
        obligations: (row as typeof row & { obligations: string }).obligations,
      }))
      .sort((left, right) => left.state.localeCompare(right.state)),
  ).toEqual([
    { state: 'abandoned', next: 'finished', obligations: '' },
    { state: 'done', next: 'finished', obligations: '' },
    { state: 'running', next: 'lens', obligations: '' },
  ])
  expect(
    (await listWorkflowCursors({ project: 'fixture' }, d)).map((row) => row.workflow_key),
  ).toEqual(['DEV-OPEN'])
  expect(
    (await listWorkflowCursors({ all: true, session: 'session-done' }, d)).map(
      (row) => row.workflow_key,
    ),
  ).toEqual(['DEV-DONE'])
  expect(cursorCount.get()).toEqual({ count: 4 })
})
