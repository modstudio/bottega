import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { database } from './workflow-cursor-test.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

const live = {}
const taskArgs = {
  key: 'DEV-2323',
  branch: 'DEV-2323-work',
  worktree: '/tmp/DEV-2323-work',
}

async function openExplore(d: Database, session: string) {
  const draft = setWorkflowLocal(
    'explore',
    {
      title: 'Explore',
      description: 'Explore fixture.',
      arguments: [{ name: 'key', required: false, description: 'Optional task key.' }],
      modes: [{ slug: 'default', title: 'Default', default: true, steps: ['diagnose'] }],
    },
    'graduation fixture',
    'test',
    d,
  )
  promoteWorkflowLocal('explore', draft.n, 'graduation fixture', 'test', d)
  const opened = await composeWorkflowWithCursor(
    'explore',
    'fixture',
    'default',
    {},
    { session },
    d,
    {},
    live,
  )
  return { id: opened.cursor!.id }
}

test('task-bound composition hands the session untouched explore cursor off', async () => {
  const d = database()
  const session = 'graduation-success'
  const explore = await openExplore(d, session)

  const composed = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    taskArgs,
    { session, taskRecordId: 'task-DEV-2323' },
    d,
    {},
    live,
  )

  expect(composed.graduated).toEqual({ cursor: explore.id, closed: true })
  const source = await taskFlowReadStore(d).stageByRecordId(
    d
      .query<{ record_id: string }, [number]>(
        'SELECT record_id FROM workflow_cursor WHERE number=?',
      )
      .get(explore.id)!.record_id,
  )
  expect(source).toMatchObject({ state: 'done' })
  expect(await taskFlowReadStore(d).stageByHandle('fixture', composed.cursor!.id)).toMatchObject({
    handed_off_from_record_id: source!.record_id,
  })
})

test('task-bound composition keeps an explore cursor with attached text intact', async () => {
  const d = database()
  const session = 'graduation-attached-text'
  const explore = await openExplore(d, session)
  const row = d
    .query<{ record_id: string }, [number]>('SELECT record_id FROM workflow_cursor WHERE number=?')
    .get(explore.id)!
  d.query(
    `INSERT INTO workflow_step_text
      (record_id,cursor_record_id,step_ordinal,step_slug,body,created_at)
     VALUES (?,?,1,'orient','attached finding','2026-11-15')`,
  ).run(newRecordId(), row.record_id)

  const composed = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    { ...taskArgs, key: 'DEV-2323-TEXT' },
    { session, taskRecordId: 'task-DEV-2323-text' },
    d,
    {},
    live,
  )

  expect(composed.graduated).toBeUndefined()
  expect(await taskFlowReadStore(d).stageByRecordId(row.record_id)).toMatchObject({
    state: 'running',
  })
  expect(
    d.query('SELECT body FROM workflow_step_text WHERE cursor_record_id=?').all(row.record_id),
  ).toEqual([{ body: 'attached finding' }])
})

test('task-bound composition reuses its open cursor and closes an untouched explore', async () => {
  const d = database()
  const session = 'graduation-reuse'
  const first = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    taskArgs,
    { session, taskRecordId: 'task-DEV-2323' },
    d,
    {},
    live,
  )
  const explore = await openExplore(d, session)

  const composed = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    taskArgs,
    { session, taskRecordId: 'task-DEV-2323' },
    d,
    {},
    live,
  )

  expect(composed.cursor).toMatchObject({ id: first.cursor!.id, opened: false })
  expect(composed.graduated).toEqual({ cursor: explore.id, closed: true })
  expect(
    d
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM workflow_cursor WHERE workflow_key=? AND state NOT IN ('done','abandoned')",
      )
      .get(taskArgs.key),
  ).toEqual({ count: 1 })
})
