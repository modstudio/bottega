import { describe, expect, test } from 'bun:test'
import type { MergedPullRequest } from './merged-pull-request.ts'
import {
  decideOtherBranchState,
  decideOtherPruneEligibility,
  isHeldBranch,
  taskKeyToken,
} from './other-branch-state.ts'

const pullRequest: MergedPullRequest = {
  number: 42,
  headRefName: 'feature/DEV-616-report',
  headRefOid: 'def456',
  title: 'DEV-616: report branches',
  mergeCommit: { oid: 'abc123' },
  mergedAt: '2026-09-16T12:00:00Z',
}

function decide(overrides: Partial<Parameters<typeof decideOtherBranchState>[0]> = {}) {
  return decideOtherBranchState({
    branch: 'feature/DEV-616-report',
    mergedPullRequests: [],
    mergedPullRequestsTruncated: false,
    pullRequestNameCheck: null,
    commitsNotOnTrunk: 1,
    patchEquivalent: null,
    pullRequestCommitCheck: null,
    ...overrides,
  })
}

describe('other local branch state decision', () => {
  test('held suffix mutation: a keep branch is displayed as held', () => {
    expect(isHeldBranch('feature/cleanup-keep')).toBe(true)
    expect(decide({ branch: 'feature/cleanup-keep', mergedPullRequests: [pullRequest] })).toEqual({
      state: 'held',
    })
  })

  test('held marker mutation: escaped and wip keep names are held', () => {
    expect(isHeldBranch('DEV-1-escaped-keep-2')).toBe(true)
    expect(isHeldBranch('DEV-1-wip-keep-copy')).toBe(true)
  })

  test('PR-name mutation: a merged PR head lands the same-named branch', () => {
    expect(
      decide({
        mergedPullRequests: [pullRequest],
        pullRequestNameCheck: { pullRequest, containsTip: true },
      }),
    ).toMatchObject({
      state: 'landed',
      landedBy: { type: 'pr', number: 42 },
    })
  })

  test('PR-head containment mutation: a reused name whose PR head does not contain the tip is not landed by PR', () => {
    expect(
      decide({
        mergedPullRequests: [pullRequest],
        pullRequestNameCheck: { pullRequest, containsTip: false },
      }),
    ).toEqual({ state: 'unlanded' })
  })

  test('patch-equivalent mutation: equivalent content lands without a PR-name match', () => {
    expect(decide({ patchEquivalent: 'squash' })).toEqual({
      state: 'landed',
      landedBy: { type: 'patch-equivalent', form: 'squash' },
    })
  })

  test('PR-commits token mutation: a task token selects commit evidence', () => {
    expect(taskKeyToken('feature/DEV-616-report', ['DEV'])).toBe('DEV-616')
    expect(taskKeyToken('feature/DEV-616report', ['DEV'])).toBeNull()
    expect(decide({ pullRequestCommitCheck: { number: 43 } })).toEqual({
      state: 'landed',
      landedBy: { type: 'pr-commits', number: 43 },
    })
  })

  test('empty mutation: no commits outside trunk reports empty', () => {
    expect(decide({ commitsNotOnTrunk: 0 })).toEqual({ state: 'empty' })
  })

  test('unlanded mutation: unmatched content reports unlanded with complete evidence', () => {
    expect(decide()).toEqual({ state: 'unlanded' })
  })

  test('truncation mutation: unmatched content is unknown when PR evidence is capped', () => {
    expect(decide({ mergedPullRequestsTruncated: true })).toEqual({ state: 'unknown' })
  })

  test('failed-check mutation: observation failure is unknown rather than empty', () => {
    expect(decide({ commitsNotOnTrunk: 0, checkError: 'rev-list failed' })).toEqual({
      state: 'unknown',
      error: 'rev-list failed',
    })
  })
})

describe('other local branch prune eligibility', () => {
  const eligible = {
    state: 'landed' as const,
    held: false,
    checkedOut: false,
    protectedKind: null,
    tipMoved: false,
  }

  test('held guard mutation: held branches are refused', () => {
    expect(decideOtherPruneEligibility({ ...eligible, held: true })).toEqual({
      eligible: false,
      reason: 'held',
    })
  })

  test('checkout guard mutation: checked-out branches are refused', () => {
    expect(decideOtherPruneEligibility({ ...eligible, checkedOut: true })).toEqual({
      eligible: false,
      reason: 'checked-out',
    })
  })

  test('protected guard mutation: registered branches are refused', () => {
    expect(decideOtherPruneEligibility({ ...eligible, protectedKind: 'trunk' })).toEqual({
      eligible: false,
      reason: 'protected',
    })
  })
})
