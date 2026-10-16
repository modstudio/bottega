import { expect, test } from 'bun:test'
import { missingPrunableWorktrees } from './worktree-porcelain.ts'

test('finds missing prunable worktrees and ignores worktrees whose directory exists', () => {
  const porcelain = `worktree /projects/example
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /runs/missing/tree
HEAD 2222222222222222222222222222222222222222
detached
prunable gitdir file points to non-existent location

`

  expect(missingPrunableWorktrees(porcelain, (path) => path === '/projects/example')).toEqual([
    {
      path: '/runs/missing/tree',
      reason: 'gitdir file points to non-existent location',
    },
  ])
})
