import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { WorkflowCursorListRow } from '../workflow/workflow-cursor-list.ts'
import { sessionReviewVerdictLines } from './session-review-verdicts.ts'

test('cursor-claimed branches skip only a merged landing at the current head', () => {
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
       VALUES (?,'fixture',?,'DEV-2336-merged','merged-tip',1,'merge','2026-11-15','2026-11-15')`,
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
      () => 'merged-tip',
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
      () => 'reworked-tip',
    ),
  ).toHaveLength(1)
  expect(gathered).toBeTrue()
  database.close()
})
