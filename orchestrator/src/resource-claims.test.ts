import { describe, expect, test } from 'bun:test'
import { createdWorktreeClaimKinds, settledStateForCloseOut } from './resource-claims.ts'

describe('resource claim decisions', () => {
  test('only orch-owned creation records worktree and minted branch claims', () => {
    expect(createdWorktreeClaimKinds({ owned: false, mintedBranch: 'DEV-1' })).toEqual([])
    expect(createdWorktreeClaimKinds({ owned: true, mintedBranch: null })).toEqual(['worktree'])
    expect(createdWorktreeClaimKinds({ owned: true, mintedBranch: 'DEV-1' })).toEqual([
      'worktree',
      'branch',
    ])
  })

  test('close-out settles only the states established by its outcome', () => {
    expect(settledStateForCloseOut('released', 'worktree')).toBe('released')
    expect(settledStateForCloseOut('forgotten', 'worktree')).toBe('forgotten')
    expect(settledStateForCloseOut('absent', 'worktree')).toBe('absent')
    expect(settledStateForCloseOut('released', 'branch')).toBe('retained')
    for (const outcome of ['held', 'live', 'failed'] as const) {
      expect(settledStateForCloseOut(outcome, 'worktree')).toBeNull()
    }
    expect(settledStateForCloseOut('released', 'retained_ref')).toBeNull()
  })
})
