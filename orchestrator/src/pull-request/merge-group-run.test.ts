import { expect, test } from 'bun:test'
import { failedMergeGroupRunFromRuns } from './merge-group-run.ts'

test('the newest failed merge-group run excludes newer non-failures on the same branch', () => {
  const run = (id: number, conclusion: string, createdAt: string) => ({
    id,
    event: 'merge_group',
    head_branch: 'gh-readonly-queue/main/pr-42-match',
    status: 'completed',
    conclusion,
    created_at: createdAt,
    html_url: `https://github.example/actions/runs/${id}`,
  })
  const runs = [
    run(9876, 'failure', '2026-10-24T10:00:00Z'),
    run(9877, 'neutral', '2026-10-24T11:00:00Z'),
    run(9878, 'skipped', '2026-10-24T12:00:00Z'),
    run(9879, 'success', '2026-10-24T13:00:00Z'),
    {
      ...run(9880, 'failure', '2026-10-24T14:00:00Z'),
      head_branch: 'gh-readonly-queue/main/pr-41-other',
    },
  ]

  expect(failedMergeGroupRunFromRuns(runs, 'main', 42)).toEqual({
    id: 9876,
    url: 'https://github.example/actions/runs/9876',
    conclusion: 'failure',
  })
})
