import { expect, test } from 'bun:test'
import { existingBranchesWithoutWorktrees } from './monitor-branches.ts'

test('selects only existing local branches without worktrees, including slash-bearing names', () => {
  const candidates = [
    { branch: 'available', started_at: '2026-09-30T10:00:00.000Z' },
    { branch: 'checked-out', started_at: '2026-09-30T11:00:00.000Z' },
    { branch: 'missing', started_at: '2026-09-30T12:00:00.000Z' },
    { branch: 'technical/AB-1-orch-2', started_at: '2026-09-30T13:00:00.000Z' },
  ]

  expect(
    existingBranchesWithoutWorktrees(
      candidates,
      ['checked-out'],
      ['available', 'checked-out', 'technical/AB-1-orch-2'],
    ),
  ).toEqual([
    { branch: 'available', started_at: '2026-09-30T10:00:00.000Z' },
    { branch: 'technical/AB-1-orch-2', started_at: '2026-09-30T13:00:00.000Z' },
  ])
})
