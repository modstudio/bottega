import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { workflowTextAttachmentToken } from '../workflow/workflow-text.ts'
import { showWorkflowText } from '../workflow/workflow-text-copy.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { UNJUDGED_OWNER_WINDOW_MS } from './cleanup-sweep-decisions.ts'
import { sweepSessionCursors } from './cleanup-sweep-explore.ts'
import { sweepSessionState } from './cleanup-sweep-session.ts'

function addExplore(database: Database, now: number) {
  const projectRecordId = newRecordId()
  database
    .query(
      `INSERT INTO project(record_id,name,path,canon,settings)
       VALUES (?,'fixture','/fixture',0,'{"trunk":"main"}')`,
    )
    .run(projectRecordId)
  const cursorRecordId = newRecordId()
  const session = 'gone-session'
  const old = new Date(now - UNJUDGED_OWNER_WINDOW_MS - 1).toISOString()
  const cursor = database
    .query<{ number: number }, (string | number)[]>(
      `INSERT INTO workflow_cursor
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
         session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,
         closed,question,total_steps,created_at,updated_at)
       VALUES (?,1,'fixture',?,'explore','default','','',?,?,?,?,0,'frame','running','[]',NULL,4,?,?)
       RETURNING number`,
    )
    .get(
      cursorRecordId,
      projectRecordId,
      session,
      workflowVersionRecordId(database, 'explore'),
      catalogueVersionRecordId(database),
      '{}',
      old,
      old,
    )!
  database.query('INSERT INTO session_seen(session_id,last_seen) VALUES (?,?)').run(session, old)
  const textRecordId = newRecordId()
  database
    .query(
      `INSERT INTO workflow_step_text
        (record_id,cursor_record_id,step_ordinal,step_slug,body,created_at)
       VALUES (?,?,1,'frame','preserved findings',?)`,
    )
    .run(textRecordId, cursorRecordId, old)
  return { cursor: cursor.number, cursorRecordId, textRecordId }
}

test('sweep expires an orphaned explore and keeps its attachment readable', async () => {
  const database = migratedTestDatabase()
  const now = Date.parse('2026-11-12T12:00:00.000Z')
  const explore = addExplore(database, now)
  const lines: string[] = []
  const presentation: CleanupPresentation = {
    log: (...values) => lines.push(values.join(' ')),
    error: (...values) => lines.push(`error: ${values.join(' ')}`),
    setExitCode: () => {},
    keptBranchLine: String,
  }

  expect(
    await sweepSessionCursors({ dryRun: false, project: null, presentation, database, now }),
  ).toBe(false)
  expect(
    database
      .query('SELECT state,closed FROM workflow_cursor WHERE record_id=?')
      .get(explore.cursorRecordId),
  ).toEqual({
    state: 'done',
    closed: expect.stringContaining('"outcome":"expired"'),
  })
  expect(
    await showWorkflowText(workflowTextAttachmentToken(explore.textRecordId), database),
  ).toEqual({
    kind: 'live',
    id: explore.textRecordId,
    cursor: explore.cursor,
    stepSlug: 'frame',
    body: 'preserved findings',
  })
  expect(lines).toContain(`expired workflow cursor ${explore.cursor} (explore)`)
})

test('session sweep reports a cursor close failure', async () => {
  const database = migratedTestDatabase()
  const now = Date.parse('2026-11-12T12:00:00.000Z')
  const explore = addExplore(database, now)
  database.query("UPDATE workflow_cursor SET closed='not-json' WHERE record_id=?").run(
    explore.cursorRecordId,
  )
  const lines: string[] = []
  const presentation: CleanupPresentation = {
    log: (...values) => lines.push(values.join(' ')),
    error: (...values) => lines.push(`error: ${values.join(' ')}`),
    setExitCode: () => {},
    keptBranchLine: String,
  }

  expect(
    await sweepSessionState({ project: null, dryRun: false, presentation, database, now }),
  ).toBe(true)
  expect(lines).toContainEqual(expect.stringContaining('could not expire workflow cursor'))
})

