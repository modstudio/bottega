import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  TASK_FLOW_STAGE_STATES,
  type TaskFlowStageState,
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
    state: Extract<TaskFlowStageState, 'done' | 'abandoned'>,
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

  const store = taskFlowReadStore(d)
  expect(
    (await store.listStages({ project: 'fixture', states: TASK_FLOW_STAGE_STATES }))
      .map((row) => ({ state: row.state, question: row.question_number }))
      .sort((left, right) => left.state.localeCompare(right.state)),
  ).toEqual([
    { state: 'abandoned', question: null },
    { state: 'done', question: null },
  ])
  expect(await store.listOpenStages({ project: 'fixture' })).toEqual([])

  const cursorCount = d.query<{ count: number }, []>('SELECT count(*) count FROM workflow_cursor')
  expect((await listWorkflowCursors({ all: true, project: 'fixture' }, d)).map((row) => row.state).sort()).toEqual([
    'abandoned',
    'done',
  ])
  expect(
    (await listWorkflowCursors({ all: true, session: 'session-done' }, d)).map(
      (row) => row.workflow_key,
    ),
  ).toEqual(['DEV-DONE'])
  expect(cursorCount.get()).toEqual({ count: 3 })
})
