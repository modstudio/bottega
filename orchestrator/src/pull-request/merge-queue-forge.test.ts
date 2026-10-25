import { expect, test } from 'bun:test'
import { failedMergeGroupRunFromRuns } from './merge-queue-forge.ts'

test('a cancelled merge-group run is failed, a success is not, and the newest failure wins', () => {
  const runs = [
    {
      id: 9876,
      event: 'merge_group',
      head_branch: 'gh-readonly-queue/main/pr-42-match',
      status: 'completed',
      conclusion: 'failure',
      created_at: '2026-10-24T10:00:00Z',
      html_url: 'https://github.example/actions/runs/9876',
    },
    {
      id: 9877,
      event: 'merge_group',
      head_branch: 'gh-readonly-queue/main/pr-42-match',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-10-24T11:00:00Z',
      html_url: 'https://github.example/actions/runs/9877',
    },
    {
      id: 9878,
      event: 'merge_group',
      head_branch: 'gh-readonly-queue/main/pr-42-match',
      status: 'completed',
      conclusion: 'cancelled',
      created_at: '2026-10-24T12:00:00Z',
      html_url: 'https://github.example/actions/runs/9878',
    },
    {
      id: 9879,
      event: 'merge_group',
      head_branch: 'gh-readonly-queue/main/pr-41-other',
      status: 'completed',
      conclusion: 'failure',
      created_at: '2026-10-24T13:00:00Z',
      html_url: 'https://github.example/actions/runs/9879',
    },
  ]

  expect(failedMergeGroupRunFromRuns(runs, 'main', 42)).toEqual({
    id: 9878,
    url: 'https://github.example/actions/runs/9878',
    conclusion: 'cancelled',
  })
})
