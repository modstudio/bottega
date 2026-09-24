import { describe, expect, test } from 'bun:test'
import { decideEvalOwnedScratchRelease } from './canon-eval-scratch.ts'

describe('eval-owned scratch worktree release', () => {
  test('an eval-owned scratch with a run is released', () => {
    expect(
      decideEvalOwnedScratchRelease({
        scratchOwnedByEval: true,
        runCreated: true,
      }),
    ).toBe('release')
  })

  test('a skipped eval with no run does not release', () => {
    expect(
      decideEvalOwnedScratchRelease({
        scratchOwnedByEval: true,
        runCreated: false,
      }),
    ).toBe('none')
  })

  test('an ordinary unregistered tree is not released as eval scratch', () => {
    expect(
      decideEvalOwnedScratchRelease({
        scratchOwnedByEval: false,
        runCreated: true,
      }),
    ).toBe('none')
  })
})
