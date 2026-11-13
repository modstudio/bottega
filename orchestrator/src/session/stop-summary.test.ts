import { expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { db } from '../database/db.ts'
import { LANDING_TREE_JOB } from '../landing-tree/landing-tree.ts'
import type { WorkflowCursorListRow } from '../workflow/workflow-cursor-list.ts'
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
  db()
    .query(
      `INSERT INTO project (record_id,name,path,stack,settings)
       VALUES (?,'fixture','/fixture','bun',
               '{"tracker":{"protocol":"hub"},"docs":{"protocol":"orch-docs"},"gate":"bun run check"}')`,
    )
    .run(newRecordId())
  const mine = addRun({ agent: 'codex', job: 'implement', session })
  const other = addRun({ agent: 'codex', job: 'implement', session: 'another-session' })
  const held = addRun({ agent: 'codex', job: 'craft', session })
  score(held, 'full', 'right')
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
    },
    db(),
  )
  const mineNumber = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(mine)!.number
  const otherNumber = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(other)!.number
  const heldNumber = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(held)!.number

  expect(result.lines).toContain('DEV-2297 · fix-defect · step ship (6 of 11)')
  expect(result.lines).toContain(
    `run ${mineNumber} implement unscored → ${PLATFORM_SLUG} score ${mineNumber} (see ${PLATFORM_SLUG} score --help)`,
  )
  expect(result.lines.join('\n')).not.toContain(`run ${otherNumber} implement unscored`)
  expect(result.lines).toContain(
    `worktree for run ${heldNumber} (craft) is held → ${PLATFORM_SLUG} run close-out ${heldNumber}`,
  )
  expect(result.lines.join('\n')).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  )
})
