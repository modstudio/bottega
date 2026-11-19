import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { boardClaimList } from '../board/board-operations.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { installTaskReader, type TaskReadPort } from './task-read-port.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import {
  args,
  context,
  database,
  selectAndNextWorkflowStep,
} from './workflow-cursor-test.fixture.ts'
import type { Floor } from './workflow-floor.ts'
import { applyFloorDecision } from './workflow-floor-apply.ts'

const floorDatabase = testDatabaseFixture((d) => {
  d.query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)').run(
    newRecordId(),
    'fixture',
    '/fixture',
    JSON.stringify({ trunk: 'main', tracker: { states: { active: 'active' } } }),
  )
})

const task = {
  key: 'DEV-1',
  record_id: 'task-1',
  project: 'fixture',
  title: 'Epic candidate',
  parent_key: null,
  source: 'fixture',
  status: 'Active',
  status_category: 'active',
  last_seen: null,
  body: null,
  opened_at: null,
}

const taskPort: TaskReadPort = {
  list: () => [task],
  show: () => ({ task }),
  duplicates: () => [],
  documents: () => [],
  document: () => ({ id: 'none', label: 'none', title: 'none', body: '', version: '1' }),
}

const floor = (kind: Floor['kind']): Floor => ({
  kind,
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'active',
  requirePullRequest: false,
  operatorRuling: false,
})

test('plan-task start floor selection does not create review debt without a review-owed floor', async () => {
  installTaskReader(taskPort)
  let reviewOwedCalls = 0
  const result = await applyFloorDecision(
    {
      id: 1,
      record_id: newRecordId(),
      project: 'fixture',
      workflow_slug: 'plan-task',
      mode_slug: 'default',
      workflow_key: 'DEV-1',
      task_record_id: null,
      args: '{"key":"DEV-1"}',
      session_id: 'session-a',
      created_at: '2026-11-19T00:00:00.000Z',
      ordinal: 1,
      step_slug: 'start',
      state: 'running',
      closed: '[{"n":1,"slug":"write","note":"planned","at":"2026-11-19T00:00:00.000Z"}]',
      enforcement: 'floors',
    },
    [floor('tracker-transition'), floor('descendants-closed')],
    { task: 'DEV-1' },
    {
      readTask: (key) => ({
        key,
        status: 'Active',
        statusCategory: 'active',
        commentIds: [],
      }),
      reviewOwed: () => {
        reviewOwedCalls++
        throw new Error('review-owed must not be consulted')
      },
    },
    true,
    floorDatabase(),
  )
  expect(result.action).toBe('allow')
  expect(reviewOwedCalls).toBe(0)
})

test('a foreign keyed advance keeps the recorded taken-over claim behavior', async () => {
  const d = database()
  await composeWorkflowWithCursor('flow', 'fixture', 'default', args, context, d, {}, {})
  d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()

  await selectAndNextWorkflowStep(
    'flow',
    'fixture',
    'default',
    args,
    'closed by foreign session',
    { ...context, session: 'foreign-session' },
    d,
  )

  const claims = (
    await boardClaimList('fixture', true, {
      env: {},
      database: d,
      taskCursorAuthority: { mode: 'coverage-read', session: null },
    })
  ).claims
  expect(claims).toHaveLength(2)
  expect(claims[0]).toMatchObject({ holder: 'session-one', closeReason: 'taken-over' })
  expect(claims[1]).toMatchObject({ holder: 'foreign-session', live: true })
})
