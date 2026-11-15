import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { WorkflowCursorListRow } from '../workflow/workflow-cursor-list.ts'
import { sessionReviewVerdictLines } from './session-review-verdicts.ts'

test('cursor-claimed branches skip merged heads but gather commits made after the merge', () => {
  const database = migratedTestDatabase()
  const projectId = newRecordId()
  database
    .query(
      `INSERT INTO project (record_id,name,path,stack,canon,settings)
       VALUES (?,'fixture','/fixture','typescript',0,'{"trunk":"main"}')`,
    )
    .run(projectId)
  database
    .query(
      `INSERT INTO branch_landing_record
       (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
       VALUES (?,'fixture',?,'DEV-2336-merged','recorded-tip',1,'merge','2026-11-15T12:00:00Z','2026-11-15T12:00:00Z')`,
    )
    .run(newRecordId(), projectId)
  const cursor = {
    workflow_slug: 'ship-task',
    workflow_key: 'DEV-2336',
    project: 'fixture',
    args: JSON.stringify({ branch: 'DEV-2336-merged' }),
  } as WorkflowCursorListRow
  let gathered = false
  const gather = () => {
    gathered = true
    return { branch: 'DEV-2336-merged', taskKey: 'DEV-2336', failure: 'gathered' }
  }

  expect(
    sessionReviewVerdictLines(
      'session',
      [cursor],
      database,
      gather,
      () => true,
      () => '2026-11-15T06:00:00-05:00',
    ),
  ).toEqual([])
  expect(gathered).toBeFalse()

  expect(
    sessionReviewVerdictLines(
      'session',
      [cursor],
      database,
      gather,
      () => true,
      () => '2026-11-15T12:00:01Z',
    ),
  ).toHaveLength(1)
  expect(gathered).toBeTrue()
  database.close()
})

test('run-derived branches with a merged landing do not gather a review verdict', () => {
  const database = migratedTestDatabase()
  const projectId = newRecordId()
  database
    .query(
      `INSERT INTO project (record_id,name,path,stack,canon,settings)
       VALUES (?,'fixture','/fixture','typescript',0,'{"trunk":"main"}')`,
    )
    .run(projectId)
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,turn,
        project_record_id,branch,launch_key,session_id)
       VALUES (?,1,'2026-11-15','codex','implement','sha',1,'head','ok',1,?,
               'DEV-2336-merged','DEV-2336','session')`,
    )
    .run(newRecordId(), projectId)
  database
    .query(
      `INSERT INTO branch_landing_record
       (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
       VALUES (?,'fixture',?,'DEV-2336-merged','landed-tip',1,'merge','2026-11-15T12:00:00Z','2026-11-15T12:00:00Z')`,
    )
    .run(newRecordId(), projectId)
  let gathered = false

  expect(
    sessionReviewVerdictLines(
      'session',
      [],
      database,
      () => {
        gathered = true
        return { branch: 'DEV-2336-merged', taskKey: 'DEV-2336', failure: 'gathered' }
      },
      () => true,
      () => '2026-11-15T13:00:00Z',
    ),
  ).toEqual([])
  expect(gathered).toBeFalse()
  database.close()
})
