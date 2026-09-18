import { describe, expect, test } from 'bun:test'
import {
  GH_TARGETED_MERGED_PR_LIMIT,
  type MergedPullRequest,
  mergedPullRequestListing,
} from './merged-pull-request.ts'
import {
  decideTaskBranchLanding,
  decideTaskBranchPullRequestCheck,
  isTaskBranchSuperseded,
  type TaskBranchRunRow,
  taskBranchLandingRefusalMessage,
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
    const refusal = decideTaskBranchLanding({
      ...landingInput,
      pullRequestCheck: { state: 'unknown', reason: 'merged PR listing was truncated' },
    })
    expect(refusal).toEqual({
      action: 'refuse',
      reason: 'merged PR listing was truncated',
      branch: 'DEV-650-orch-4390',
      tip: '6347bc9a',
    })
    if (refusal.action !== 'refuse') throw new Error('expected refusal')
    const message = taskBranchLandingRefusalMessage(refusal, 'develop')
    expect(message).toContain('--base DEV-650-orch-4390')
    expect(message).toContain('--base develop')
  })
})

const pullRequest = (number: number): MergedPullRequest => ({
  number,
  headRefName: `feature-${number}`,
  headRefOid: `oid-${number}`,
  title: `PR ${number}`,
  mergeCommit: null,
  mergedAt: '2026-09-18T00:00:00Z',
})

const listing = (count: number) =>
  mergedPullRequestListing(
    Array.from({ length: count }, (_, index) => pullRequest(index)),
    GH_TARGETED_MERGED_PR_LIMIT,
  )

describe('targeted task branch pull-request decision', () => {
  test('truncation-guard mutation: exactly the targeted limit remains unknown', () => {
    expect(
      decideTaskBranchPullRequestCheck({
        listings: [listing(GH_TARGETED_MERGED_PR_LIMIT), listing(0)],
        nameCheck: null,
        commitCheck: null,
      }),
    ).toEqual({
      state: 'unknown',
      reason: 'targeted merged pull-request listing reached 100 entries and may be truncated',
    })
  })

  test('overconservative-truncation mutation: fewer than the targeted limit is decided', () => {
    expect(
      decideTaskBranchPullRequestCheck({
        listings: [listing(GH_TARGETED_MERGED_PR_LIMIT - 1), listing(0)],
        nameCheck: null,
        commitCheck: null,
      }),
    ).toEqual({ state: 'unmatched' })
  })
})
