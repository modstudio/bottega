import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { database } from './workflow-cursor-test.fixture.ts'

const live = {}
const taskArgs = {
  key: 'DEV-2323',
  branch: 'DEV-2323-work',
  worktree: '/tmp/DEV-2323-work',
}

function openExplore(d: Database, session: string) {
  return d
    .query<{ id: number }, (string | number)[]>(
      `INSERT INTO workflow_cursor
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
         session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,
         closed,question,total_steps,created_at,updated_at)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture',
               (SELECT record_id FROM project WHERE name='fixture'),'explore','default','','',?,?,?,
               '{}',0,'orient','running','[]',NULL,4,'2026-11-15','2026-11-15')
       RETURNING number id`,
    )
    .get(newRecordId(), session, workflowVersionRecordId(d), catalogueVersionRecordId(d))!
}

test('task-bound composition closes the session untouched explore cursor', async () => {
  const d = database()
  const session = 'graduation-success'
  const explore = openExplore(d, session)

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
  expect(
    await taskFlowReadStore(d).stageByRecordId(
      d
        .query<{ record_id: string }, [number]>(
          'SELECT record_id FROM workflow_cursor WHERE number=?',
        )
        .get(explore.id)!.record_id,
    ),
  ).toMatchObject({ state: 'done' })
})

test('a close failure leaves the task-bound composition succeeded with its reason', async () => {
  const d = database()
  const session = 'graduation-close-failure'
  const explore = openExplore(d, session)

  const composed = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    { ...taskArgs, key: 'DEV-2323-FAIL' },
    { session, taskRecordId: 'task-DEV-2323-fail' },
    d,
    {},
    live,
    () => null,
    {
      closeExplore: async () => {
        throw new Error('injected explore close failure')
      },
    },
  )

  expect(composed.cursor).not.toBeNull()
  expect(composed.graduated).toEqual({
    cursor: explore.id,
    closed: false,
    reason: 'injected explore close failure',
  })
})
