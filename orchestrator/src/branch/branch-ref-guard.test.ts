import { describe, expect, test } from 'bun:test'
import { decideBranchRefMutation } from './branch-ref-guard.ts'

describe('branch ref mutation guard', () => {
  test('finds a case-fold collision before creation', () => {
    expect(
      decideBranchRefMutation({
        operation: 'create',
        target: 'worktree-dev-1444-hono',
        localBranches: ['main', 'worktree-DEV-1444-hono'],
      }),
    ).toEqual({
      allowed: false,
      reason: 'case-collision',
      existing: 'worktree-DEV-1444-hono',
    })
  })

  test('allows an exact creation match to keep existing collision behavior', () => {
    expect(
      decideBranchRefMutation({
        operation: 'create',
        target: 'DEV-1444-hono',
        localBranches: ['main', 'DEV-1444-hono'],
      }),
    ).toEqual({ allowed: true })
  })

  test('allows unrelated branch names', () => {
    expect(
      decideBranchRefMutation({
        operation: 'create',
        target: 'DEV-1470-guard',
        localBranches: ['main', 'DEV-1444-hono'],
      }),
    ).toEqual({ allowed: true })
  })

  test('refuses deletion when another ref folds onto the target', () => {
    expect(
      decideBranchRefMutation({
        operation: 'delete',
        target: 'worktree-dev-1444-hono',
        localBranches: ['worktree-dev-1444-hono', 'worktree-DEV-1444-hono'],
      }),
    ).toEqual({
      allowed: false,
      reason: 'case-collision',
      existing: 'worktree-DEV-1444-hono',
    })
  })

  test('classifies an absent exact deletion target without a case peer', () => {
    expect(
      decideBranchRefMutation({
        operation: 'delete',
        target: 'DEV-1470-missing',
        localBranches: ['main', 'DEV-1470-other'],
      }),
    ).toEqual({ allowed: false, reason: 'exact-missing' })
  })
})
