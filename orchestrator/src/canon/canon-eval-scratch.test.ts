import { describe, expect, test } from 'bun:test'
import {
  decideEvalOwnedScratchRelease,
  decideEvalScratchWorktreeMatch,
  thrownEvalRunId,
} from './canon-eval-scratch.ts'

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

  test('a recorded worktree matches the scratch repo across a /private symlink prefix', () => {
    const spelled = '/var/folders/zz/scratch/.claude/worktrees'
    const resolved = '/private/var/folders/zz/scratch/.claude/worktrees'
    expect(
      decideEvalScratchWorktreeMatch({
        worktree: `${resolved}/orch-6092`,
        scratchTreeRoot: spelled,
      }),
    ).toBe(true)
    expect(
      decideEvalScratchWorktreeMatch({
        worktree: `${spelled}/orch-6092`,
        scratchTreeRoot: resolved,
      }),
    ).toBe(true)
    expect(
      decideEvalScratchWorktreeMatch({
        worktree: '/private/var/folders/zz/other/.claude/worktrees/orch-6092',
        scratchTreeRoot: spelled,
      }),
    ).toBe(false)
  })

  test('a thrown run with runId on the error is released', () => {
    const error = Object.assign(new Error('run 6092 failed: agent died'), { runId: 6092 })
    const runId = thrownEvalRunId(error)
    expect(runId).toBe(6092)
    expect(
      decideEvalOwnedScratchRelease({
        scratchOwnedByEval: true,
        runCreated: runId !== null,
      }),
    ).toBe('release')
    expect(thrownEvalRunId(new Error('run failed without an id'))).toBeNull()
  })
})
