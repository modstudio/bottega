import { expect, test } from 'bun:test'
import { stoppedWorktreeDisposition, stoppedWorktreeLine } from './stopped-worktree-decision.ts'

test('stop releases a read-only job tree and keeps a writing job tree', () => {
  expect(
    stoppedWorktreeDisposition({ readOnlyJob: true, worktree: '/tmp/reader-clone' }),
  ).toBe('release')
  expect(
    stoppedWorktreeDisposition({ readOnlyJob: false, worktree: '/tmp/writer-tree' }),
  ).toBe('keep')
  expect(stoppedWorktreeDisposition({ readOnlyJob: true, worktree: null })).toBe('none')
  expect(stoppedWorktreeDisposition({ readOnlyJob: false, worktree: null })).toBe('none')
})

test('stop names the released reader clone and the kept writing tree', () => {
  expect(
    stoppedWorktreeLine(
      'release',
      '/tmp/reader-clone',
      'DEV-1540-review',
      false,
      'found no Docker containers to reclaim',
    ),
  ).toBe('released worktree /tmp/reader-clone; found no Docker containers to reclaim')
  expect(
    stoppedWorktreeLine(
      'keep',
      '/tmp/writer-tree',
      'DEV-1540-orch-1',
      true,
      'found no Docker containers to reclaim',
    ),
  ).toBe(
    'kept worktree /tmp/writer-tree and branch DEV-1540-orch-1 for continuation; found no Docker containers to reclaim',
  )
})
