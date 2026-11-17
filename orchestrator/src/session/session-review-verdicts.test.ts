import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { WorkflowCursorListRow } from '../workflow/workflow-cursor-list.ts'
import {
  landedBranchOwesNoReviewLine,
  sessionReviewVerdictLines,
} from './session-review-verdicts.ts'

test('landed branch review-line decisions use commit identity and ancestry', () => {
  expect(
    landedBranchOwesNoReviewLine({
      head: 'landed-tip',
      tip: 'landed-tip',
      headIsAncestorOfTip: false,
    }),
  ).toBeTrue()
  expect(
    landedBranchOwesNoReviewLine({
      head: 'pre-rebase-head',
      tip: 'landed-tip',
      headIsAncestorOfTip: true,
    }),
  ).toBeTrue()
  expect(
    landedBranchOwesNoReviewLine({
      head: null,
      tip: 'landed-tip',
      headIsAncestorOfTip: false,
    }),
  ).toBeTrue()
  expect(
    landedBranchOwesNoReviewLine({
      head: 'post-merge-head',
      tip: 'landed-tip',
      headIsAncestorOfTip: false,
    }),
  ).toBeFalse()
})

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
  let gatherCount = 0
  const gather = () => {
    gatherCount += 1
    return { branch: 'DEV-2336-merged', taskKey: 'DEV-2336', failure: 'gathered' }
  }
  let identity = { head: 'recorded-tip' as string | null, headIsAncestorOfTip: false }
  const lines = () =>
    sessionReviewVerdictLines(
      'session',
      [cursor],
      database,
      gather,
      () => identity,
    )

  expect(lines()).toEqual([])
  expect(gatherCount).toBe(0)

  identity = { head: 'pre-rebase-head', headIsAncestorOfTip: true }
  expect(lines()).toEqual([])
  expect(gatherCount).toBe(0)

  identity = { head: null, headIsAncestorOfTip: false }
  expect(lines()).toEqual([])
  expect(gatherCount).toBe(0)

  identity = { head: 'post-merge-head', headIsAncestorOfTip: false }
  expect(lines()).toHaveLength(1)
  expect(gatherCount).toBe(1)
  database.close()
})

test('a fix-defect cursor contributes its explicit branch', () => {
  const database = migratedTestDatabase()
  const projectId = newRecordId()
  database
    .query(
      `INSERT INTO project (record_id,name,path,stack,canon,settings)
       VALUES (?,'fixture','/fixture','typescript',0,'{"trunk":"main"}')`,
    )
    .run(projectId)
  const cursor = {
    workflow_slug: 'fix-defect',
    workflow_key: 'DEV-2403',
    project: 'fixture',
    args: JSON.stringify({ branch: 'DEV-2403-work' }),
  } as WorkflowCursorListRow
  const gathered: string[] = []

  expect(
    sessionReviewVerdictLines(
      'session',
      [cursor],
      database,
      (branch) => {
        gathered.push(branch.branch)
        return { branch: branch.branch, taskKey: branch.taskKey, failure: 'gathered' }
      },
    ),
  ).toEqual([
    `DEV-2403: review verdict unavailable (gathered) → ${PLATFORM_SLUG} review tier DEV-2403`,
  ])
  expect(gathered).toEqual(['DEV-2403-work'])
  database.close()
})

test('a root writing run without this session cursor contributes no branch', () => {
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
               'DEV-2403-work','DEV-2403','session')`,
    )
    .run(newRecordId(), projectId)
  let gathered = false

  expect(
    sessionReviewVerdictLines('session', [], database, () => {
      gathered = true
      return { branch: 'DEV-2403-work', taskKey: 'DEV-2403', failure: 'unexpected' }
    }),
  ).toEqual([])
  expect(gathered).toBeFalse()
  database.close()
})

test('a keyed cursor without a branch resolves its task branch', () => {
  const database = migratedTestDatabase()
  const projectId = newRecordId()
  database
    .query(
      `INSERT INTO project (record_id,name,path,stack,canon,settings)
       VALUES (?,'fixture','/fixture','typescript',0,'{"trunk":"main"}')`,
    )
    .run(projectId)
  const cursor = {
    workflow_slug: 'fix-defect',
    workflow_key: 'DEV-2403',
    project: 'fixture',
    args: '{}',
  } as WorkflowCursorListRow

  expect(
    sessionReviewVerdictLines(
      'session',
      [cursor],
      database,
      (branch) => ({ branch: branch.branch, taskKey: branch.taskKey, failure: 'gathered' }),
      undefined,
      () => ({ branch: 'DEV-2403-resolved' }),
    ),
  ).toEqual([
    `DEV-2403: review verdict unavailable (gathered) → ${PLATFORM_SLUG} review tier DEV-2403`,
  ])
  database.close()
})
