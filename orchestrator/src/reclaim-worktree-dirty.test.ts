import { describe, expect, test } from 'bun:test'
import { reclaimDirtyTreeRefusal } from './reclaim-worktree-dirty.ts'

const path = '/projects/starship/.claude/worktrees/orch-3939'

describe('reclaimDirtyTreeRefusal', () => {
  test('dirty tree is refused — catches dropping the dirty-tree check', () => {
    expect(
      reclaimDirtyTreeRefusal({
        path,
        treeExists: true,
        dirty: { dirty: true, detail: 'has uncommitted or untracked changes' },
      }),
    ).toEqual({
      ok: false,
      action:
        'refused; worktree /projects/starship/.claude/worktrees/orch-3939 has uncommitted or untracked changes; commit or discard the changes and retry',
    })
  })

  test('uninspectable tree is refused — catches treating could-not-inspect as clean', () => {
    expect(
      reclaimDirtyTreeRefusal({
        path,
        treeExists: true,
        dirty: { dirty: true, detail: 'could not inspect uncommitted or untracked work' },
      }),
    ).toEqual({
      ok: false,
      action:
        'refused; worktree /projects/starship/.claude/worktrees/orch-3939 could not inspect uncommitted or untracked work; commit or discard the changes and retry',
    })
  })

  test('clean tree is not refused — catches refusing every existing tree', () => {
    expect(
      reclaimDirtyTreeRefusal({
        path,
        treeExists: true,
        dirty: { dirty: false, detail: 'all work is committed' },
      }),
    ).toBeNull()
  })
})
