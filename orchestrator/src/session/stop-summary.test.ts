import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { writeCachedDisplayTimezone } from '../config/display-timezone-cache.ts'
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
      reviewTaskBranchResolver: () => ({ branch: 'DEV-2297-work' }),
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
    `DEV-2297: 2 review lenses owed → ${PLATFORM_SLUG} review tier DEV-2297`,
  )
  expect(result.lines).toContain('In progress: 1 run')
  expect(result.lines.some((line) => line.includes(`(implement): ${otherNumber}`))).toBeFalse()
  expect(result.lines).toContain(
    `1 held worktree (craft): ${heldNumber} → ${PLATFORM_SLUG} run close-out <run>`,
  )
  expect(result.lines.join('\n')).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  )
})

test('session summary renders line one in the cached display time zone', async () => {
  const state = mkdtempSync(join(tmpdir(), 'stop-summary-timezone-'))
  const stateEnvironment = { BOTTEGA_STATE_HOME: state }
  try {
    writeCachedDisplayTimezone('America/New_York', stateEnvironment)
    const result = await sessionStopSummary(
      {
        session: 'cached-timezone-session',
        previousBlockKey: null,
        now: '2026-11-13T12:00:00.000Z',
        stateEnvironment,
      },
      db(),
    )

    expect(result.lines[0]).toMatch(/^\d{1,2}:\d{2} [AP]M (?:EST|EDT)$/)
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})

test('an open cursor branch with a missing ref keeps its verdict failure line', () => {
  const missingCursor = {
    ...cursor,
    project: PLATFORM_NAME,
    workflow_key: 'DEV-2304',
    args: JSON.stringify({ branch: 'DEV-2304-gone' }),
  } as WorkflowCursorListRow
  const lines = sessionReviewVerdictLines(
    'missing-cursor-branch-session',
    [missingCursor],
    db(),
    (branch) => ({
      branch: branch.branch,
      taskKey: branch.taskKey,
      failure: 'Error: git could not resolve branch DEV-2304-gone',
    }),
  )

  expect(lines).toEqual([
    `DEV-2304: review verdict unavailable (Error: git could not resolve branch DEV-2304-gone) → ${PLATFORM_SLUG} review tier DEV-2304`,
  ])
})
