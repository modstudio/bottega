import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { closeExploreForLifecycle } from './workflow-explore-lifecycle-close.ts'

function addExplore(database: Database, workflowKey = ''): string {
  const projectRecordId = newRecordId()
  database
    .query(
      `INSERT INTO project(record_id,name,path,canon,settings)
       VALUES (?,'fixture','/fixture',0,'{"trunk":"main"}')`,
    )
    .run(projectRecordId)
  const cursorRecordId = newRecordId()
  database
    .query(
      `INSERT INTO workflow_cursor
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
         session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,
         closed,question,total_steps,created_at,updated_at)
       VALUES (?,1,'fixture',?,'explore','default',?,'','session',?,?, '{}',1,'investigate',
               'running','[]',NULL,4,'2026-11-12','2026-11-12')`,
    )
    .run(
      cursorRecordId,
      projectRecordId,
      workflowKey,
      workflowVersionRecordId(database, 'explore'),
      catalogueVersionRecordId(database),
    )
  return cursorRecordId
}

function cursorState(database: Database, cursorRecordId: string) {
  return database
    .query<{ state: string; closed: string }, [string]>(
      'SELECT state,closed FROM workflow_cursor WHERE record_id=?',
    )
    .get(cursorRecordId)
}

test('refuses an explore with an open question without changing it', async () => {
  const database = migratedTestDatabase()
  const cursorRecordId = addExplore(database)
  const questionRecordId = newRecordId()
  database
    .query(
      `INSERT INTO question
        (record_id,number,workflow_cursor_record_id,asked_at,question,asked_via)
       VALUES (?,1,?,'2026-11-12','Which path?','workflow')`,
    )
    .run(questionRecordId, cursorRecordId)

  await expect(closeExploreForLifecycle(cursorRecordId, 'expired', database)).rejects.toThrow(
    `workflow question ${questionRecordId} is still open`,
  )
  expect(cursorState(database, cursorRecordId)).toEqual({ state: 'running', closed: '[]' })
})

test('refuses a keyed explore without changing it', async () => {
  const database = migratedTestDatabase()
  const cursorRecordId = addExplore(database, 'DEV-2289')

  await expect(closeExploreForLifecycle(cursorRecordId, 'answered', database)).rejects.toThrow(
    'workflow cursor 1 is not a keyless explore',
  )
  expect(cursorState(database, cursorRecordId)).toEqual({ state: 'running', closed: '[]' })
})
