import { expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { db } from '../database/db.ts'
import { LANDING_TREE_JOB } from '../landing-tree/landing-tree.ts'
import type { WorkflowCursorListRow } from '../workflow/workflow-cursor-list.ts'
import { sessionReviewVerdictLines } from './session-review-verdicts.ts'
import {
  landingTreeIsActive,
  type StopSummaryHeldTreeRow,
  sessionStopSummary,
} from './stop-summary.ts'

const tree: StopSummaryHeldTreeRow = {
  record_id: 'tree-run',
  number: 12,
  job: LANDING_TREE_JOB,
  repo: PLATFORM_NAME,
  branch: 'DEV-2297-work',
  worktree: '/tmp/DEV-2297-work',
  close_out_attempted_at: null,
}

const cursor = {
  id: 7,
  workflow_slug: 'ship-task',
  step_slug: 'land',
  project: PLATFORM_NAME,
  args: JSON.stringify({ branch: tree.branch, worktree: tree.worktree }),
} as WorkflowCursorListRow

test('landing trees are active for a matching ship cursor or any matching active landing', () => {
  expect(landingTreeIsActive(tree, [cursor], [])).toBeTrue()
  expect(
    landingTreeIsActive(tree, [], [{ project: PLATFORM_NAME, branch: 'DEV-2297-work' }]),
  ).toBeTrue()
  expect(
    landingTreeIsActive(tree, [], [{ project: PLATFORM_NAME, branch: 'DEV-other' }]),
  ).toBeFalse()
  expect(landingTreeIsActive(tree, [{ ...cursor, step_slug: 'close-task' }], [])).toBeFalse()
})

test('session summary assembles only this session owed runs, held remedies, and cursor ordinal', async () => {
  const session = 'stop-summary-session'
  const projectRecordId = newRecordId()
  db()
    .query(
      `INSERT INTO project (record_id,name,path,stack,settings)
       VALUES (?,'fixture','/fixture','bun',
               '{"tracker":{"protocol":"hub"},"docs":{"protocol":"orch-docs"},"gate":"bun run check"}')`,
    )
    .run(projectRecordId)
  const mine = addRun({ agent: 'codex', job: 'implement', session })
  const worker = addRun({ agent: 'codex', job: 'implement', status: 'asking', session })
  const other = addRun({ agent: 'codex', job: 'implement', session: 'another-session' })
  const held = addRun({ agent: 'codex', job: 'craft', session })
  score(held, 'full', 'right')
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,'Which?')`,
    )
    .run(newRecordId(), worker, new Date().toISOString())
  db()
    .query(
      `UPDATE run SET project_record_id=?,repo='fixture',branch='DEV-2297-work',
              worktree='/fixture',launch_key='DEV-2297' WHERE record_id=?`,
    )
    .run(projectRecordId, mine)
  db()
    .query(
      `UPDATE run SET worktree='/tmp/held-worktree',close_out_outcome='held',
              close_out_detail='tree kept because live run 01a1d552-4256-72f6-a2ea-ae19749602d2 names it; close-out intent=terminal',
              close_out_attempted_at='2026-11-13T10:00:00.000Z'
        WHERE record_id=?`,
    )
    .run(held)
  db()
    .query(
      `INSERT INTO workflow_cursor
        (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
         workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
         question,total_steps,created_at,updated_at)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture','fix-defect',
               'default','DEV-2297',?, ?,?,?,?,5,'ship','running','[]',NULL,11,
               '2026-11-13','2026-11-13')`,
    )
    .run(
      newRecordId(),
      newRecordId(),
      session,
      workflowVersionRecordId(db(), 'fix-defect'),
      catalogueVersionRecordId(db()),
      JSON.stringify({ key: 'DEV-2297' }),
    )

  const result = await sessionStopSummary(
    {
      session,
      previousBlockKey: null,
      now: '2026-11-13T12:00:00.000Z',
      reviewVerdictGatherer: (branch) => ({
        branch: branch.branch,
        taskKey: branch.taskKey,
        verdict: {
          change: {
            project: branch.project,
            branch: branch.branch,
            taskKey: branch.taskKey,
            head: 'head',
            patchId: 'patch',
            pathSet: 'paths',
            paths: ['orchestrator/src/session/stop-summary.ts'],
          },
          lenses: [
            { lens: 'correctness', status: 'owed' as const, reason: 'initial' as const },
            { lens: 'craft', status: 'owed' as const, reason: 'initial' as const },
          ],
          next: { action: 'dispatch' as const, lenses: ['correctness', 'craft'] },
        },
      }),
      reviewBranchRefExists: () => true,
    },
    db(),
  )
  const otherNumber = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(other)!.number
  const heldNumber = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(held)!.number

  expect(result.lines).toContain('DEV-2297 · fix-defect · step ship (6 of 11)')
  expect(result.lines).toContain(
    `1 worker question for this session → ${PLATFORM_SLUG} question inbox`,
  )
  expect(result.lines).toContain(
    `DEV-2297 review: lens correctness, craft owed → ${PLATFORM_SLUG} review tier DEV-2297-work`,
  )
  expect(result.lines).toContain('In progress: 1 run')
  expect(result.lines.join('\n')).not.toContain(`run ${otherNumber} implement unscored`)
  expect(result.lines).toContain(
    `worktree for run ${heldNumber} (craft) is held → ${PLATFORM_SLUG} run close-out ${heldNumber}`,
  )
  expect(result.lines.join('\n')).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  )
})

test('a run-derived branch with a missing main-checkout ref has no review line', () => {
  const session = 'missing-run-branch-session'
  const run = addRun({ agent: 'codex', job: 'implement', session })
  db()
    .query(`UPDATE run SET branch='DEV-2304-gone',launch_key='DEV-2304' WHERE record_id=?`)
    .run(run)
  let gathered = false

  const lines = sessionReviewVerdictLines(
    session,
    [],
    db(),
    () => {
      gathered = true
      return { branch: 'DEV-2304-gone', taskKey: 'DEV-2304', failure: 'unexpected gather' }
    },
    () => false,
  )

  expect(lines).toEqual([])
  expect(gathered).toBeFalse()
})

test('a landed run-derived branch does not gather a review verdict', () => {
  const session = 'landed-run-branch-session'
  const run = addRun({ agent: 'codex', job: 'implement', session })
  const project = db()
    .query<{ record_id: string; name: string }, [string]>(
      'SELECT project.record_id,project.name FROM project JOIN run ON run.project_record_id=project.record_id WHERE run.record_id=?',
    )
    .get(run)!
  db()
    .query(`UPDATE run SET branch='DEV-2304-landed',launch_key='DEV-2304' WHERE record_id=?`)
    .run(run)
  db()
    .query(
      `INSERT INTO branch_landing_record
       (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recorded_at,recording_session)
       VALUES (?,?,?,?,?,1,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      project.name,
      project.record_id,
      'DEV-2304-landed',
      'tip',
      'merge',
      '2026-11-15T12:00:00.000Z',
      '2026-11-15T12:00:00.000Z',
      session,
    )
  let gathered = false

  const lines = sessionReviewVerdictLines(
    session,
    [],
    db(),
    () => {
      gathered = true
      return { branch: 'DEV-2304-landed', taskKey: 'DEV-2304', failure: 'unexpected gather' }
    },
    () => true,
    () => 'tip',
  )

  expect(lines).toEqual([])
  expect(gathered).toBeFalse()
})

test('an abandoned later turn excludes its root writing-run branch', () => {
  const session = 'abandoned-run-chain-session'
  const root = addRun({ agent: 'codex', job: 'implement', session })
  addRun({ agent: 'codex', job: 'implement', session, parent: root, turn: 2, kind: 'abandoned' })
  db()
    .query(`UPDATE run SET branch='DEV-2304-retained',launch_key='DEV-2304' WHERE record_id=?`)
    .run(root)
  let gathered = false

  const lines = sessionReviewVerdictLines(
    session,
    [],
    db(),
    () => {
      gathered = true
      return { branch: 'DEV-2304-retained', taskKey: 'DEV-2304', failure: 'unexpected gather' }
    },
    () => true,
  )

  expect(lines).toEqual([])
  expect(gathered).toBeFalse()
})

test('an open cursor branch with a missing ref keeps its verdict failure line', () => {
  const missingCursor = {
    ...cursor,
    project: PLATFORM_NAME,
    workflow_key: 'DEV-2304',
    args: JSON.stringify({ branch: 'DEV-2304-gone' }),
  } as WorkflowCursorListRow
  let checked = false

  const lines = sessionReviewVerdictLines(
    'missing-cursor-branch-session',
    [missingCursor],
    db(),
    (branch) => ({
      branch: branch.branch,
      taskKey: branch.taskKey,
      failure: 'Error: git could not resolve branch DEV-2304-gone',
    }),
    () => {
      checked = true
      return false
    },
  )

  expect(lines).toEqual([
    `DEV-2304 review: verdict unavailable (Error: git could not resolve branch DEV-2304-gone) → ${PLATFORM_SLUG} review tier DEV-2304-gone`,
  ])
  expect(checked).toBeFalse()
})
