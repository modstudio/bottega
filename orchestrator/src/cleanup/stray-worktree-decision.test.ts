import { describe, expect, test } from 'bun:test'
import { STRAY_WORKTREE_QUIET_WINDOW_MS, strayWorktreeDecision } from './stray-worktree-decision.ts'

describe('stray worktree decision', () => {
  test('keeps a claimed directory', () => {
    expect(
      strayWorktreeDecision({ established: true, claimed: true, ageMs: Number.MAX_SAFE_INTEGER }),
    ).toBe('keep-claimed')
  })

  test('keeps a recently modified directory', () => {
    expect(
      strayWorktreeDecision({
        established: true,
        claimed: false,
        ageMs: STRAY_WORKTREE_QUIET_WINDOW_MS,
      }),
    ).toBe('keep-recent')
  })

  test('archives a stale unclaimed directory', () => {
    expect(
      strayWorktreeDecision({
        established: true,
        claimed: false,
        ageMs: STRAY_WORKTREE_QUIET_WINDOW_MS + 1,
      }),
    ).toBe('archive')
  })

  test('only reports an unestablished directory', () => {
    expect(
      strayWorktreeDecision({ established: false, claimed: false, ageMs: Number.MAX_SAFE_INTEGER }),
    ).toBe('report-only')
  })
})
