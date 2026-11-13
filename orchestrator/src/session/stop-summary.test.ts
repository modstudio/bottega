import { expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { LANDING_TREE_JOB } from '../landing-tree/landing-tree.ts'
import type { WorkflowCursorListRow } from '../workflow/workflow-cursor-list.ts'
import { hookNotes, landingTreeIsActive, type StopSummaryHeldTreeRow } from './stop-summary.ts'

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
})

test('validated hook notes become owed items with their hand-off command', () => {
  expect(
    hookNotes(
      [
        {
          label: 'handoff-summary',
          project: PLATFORM_NAME,
          last_seen_at: '2026-11-13T10:00:00.000Z',
        },
      ],
      '2026-11-13T12:00:00.000Z',
    ),
  ).toEqual([
    {
      label: 'note handoff-summary not handed over',
      command: `${PLATFORM_SLUG} board post --audience architects:${PLATFORM_NAME} ...`,
      owedAt: '2026-11-13T10:00:00.000Z',
    },
  ])
})
