import { describe, expect, test } from 'bun:test'
import {
  decideTaskBranchLanding,
  isTaskBranchSuperseded,
  type TaskBranchRunRow,
} from './task-branch.ts'

const row = (
  id: number,
  branch: string,
  launchBase: string | null,
  parentRunId: number | null = null,
): TaskBranchRunRow => ({
  id,
  parent_run_id: parentRunId,
  branch,
  launch_base: launchBase,
})

describe('task branch supersession', () => {
  test('a later explicit-base root run supersedes an earlier branch', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row(10, 'DEV-609-old', null),
        row(11, 'DEV-609-new', 'main'),
      ]),
    ).toBe(true)
  })

  test('a later root run without a launch base does not supersede', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row(10, 'DEV-609-old', null),
        row(11, 'DEV-609-new', null),
      ]),
    ).toBe(false)
  })

  test('a later resume with an inherited launch base does not supersede', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row(10, 'DEV-609-old', null),
        row(11, 'DEV-609-new', 'main', 9),
      ]),
    ).toBe(false)
  })

  test('a later explicit-base run on the same branch does not supersede', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row(10, 'DEV-609-old', null),
        row(11, 'DEV-609-old', 'main'),
      ]),
    ).toBe(false)
  })
})

const landingInput = {
  branch: 'DEV-650-orch-4390',
  tip: '6347bc9a',
  trunk: 'develop',
  localCheck: null,
  pullRequestCheck: { state: 'unmatched' } as const,
}

describe('task branch landing decision', () => {
  test('local-check mutation: patch-equivalent content is skipped before an unknown PR result', () => {
    expect(
      decideTaskBranchLanding({
        ...landingInput,
        localCheck: 'commits',
        pullRequestCheck: { state: 'unknown', reason: 'gh failed' },
      }),
    ).toEqual({ action: 'skip' })
  })

  test('PR-name mutation: a containing merged PR head skips the branch', () => {
    expect(
      decideTaskBranchLanding({
        ...landingInput,
        pullRequestCheck: { state: 'landed', landedBy: 'name', number: 216 },
      }),
    ).toEqual({ action: 'skip', number: 216 })
  })

  test('PR-commits mutation: a patch-matching merged PR skips the branch', () => {
    expect(
      decideTaskBranchLanding({
        ...landingInput,
        pullRequestCheck: { state: 'landed', landedBy: 'pr-commits', number: 217 },
      }),
    ).toEqual({ action: 'skip', number: 217 })
  })

  test('no-match mutation: a completed unmatched PR check keeps the candidate', () => {
    expect(decideTaskBranchLanding(landingInput)).toEqual({ action: 'keep' })
  })

  test('unknown-state mutation: an incomplete PR check refuses with the explicit-base remedy', () => {
    expect(
      decideTaskBranchLanding({
        ...landingInput,
        pullRequestCheck: { state: 'unknown', reason: 'merged PR listing was truncated' },
      }),
    ).toEqual({
      action: 'refuse',
      message:
        'refusing task branch DEV-650-orch-4390 tip 6347bc9a: GitHub landing check could not complete: merged PR listing was truncated; rerun with --base develop',
    })
  })
})
