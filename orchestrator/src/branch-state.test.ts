import { describe, expect, test } from 'bun:test'
import { decideBranchState, type MergedPullRequest } from './branch-state.ts'

const pullRequest: MergedPullRequest = {
  number: 42,
  headRefName: 'DEV-616-orch-4235',
  mergeCommit: { oid: 'abc123' },
  mergedAt: '2026-09-16T12:00:00Z',
}

function decide(overrides: Partial<Parameters<typeof decideBranchState>[0]> = {}) {
  return decideBranchState({
    branch: pullRequest.headRefName,
    mergedPullRequests: [],
    mergedPullRequestsTruncated: false,
    commitsNotOnTrunk: 1,
    patchEquivalent: null,
    superseded: false,
    ...overrides,
  })
}

describe('run branch state decision', () => {
  test('PR landing precedence mutation: landed by PR beats superseded', () => {
    expect(decide({ mergedPullRequests: [pullRequest], superseded: true })).toEqual({
      state: 'landed',
      landedBy: {
        type: 'pr',
        number: 42,
        mergeCommit: 'abc123',
        mergedAt: '2026-09-16T12:00:00Z',
      },
    })
  })

  test('patch landing precedence mutation: patch equivalence beats superseded without a PR', () => {
    expect(decide({ patchEquivalent: 'commits', superseded: true })).toEqual({
      state: 'landed',
      landedBy: { type: 'patch-equivalent', form: 'commits' },
    })
  })

  test('landing signal order mutation: a matching PR wins over patch equivalence', () => {
    expect(decide({ mergedPullRequests: [pullRequest], patchEquivalent: 'squash' })).toMatchObject({
      state: 'landed',
      landedBy: { type: 'pr' },
    })
  })

  test('empty precedence mutation: empty beats patch equivalence', () => {
    expect(decide({ commitsNotOnTrunk: 0, patchEquivalent: 'commits' })).toEqual({
      state: 'empty',
    })
  })

  test('PR proof precedence mutation: a matching PR beats empty', () => {
    expect(decide({ mergedPullRequests: [pullRequest], commitsNotOnTrunk: 0 })).toMatchObject({
      state: 'landed',
      landedBy: { type: 'pr' },
    })
  })

  test('supersession fallback mutation: an unmatched superseded branch is superseded', () => {
    expect(decide({ superseded: true })).toEqual({ state: 'superseded' })
  })

  test('complete-history fallback mutation: an unmatched branch is unlanded', () => {
    expect(decide()).toEqual({ state: 'unlanded' })
  })

  test('truncation safety mutation: an unmatched branch is unknown when the PR list is capped', () => {
    expect(decide({ mergedPullRequestsTruncated: true })).toEqual({ state: 'unknown' })
  })

  test('truncated-match mutation: a matching PR remains landed when the PR list is capped', () => {
    expect(
      decide({ mergedPullRequests: [pullRequest], mergedPullRequestsTruncated: true }),
    ).toMatchObject({ state: 'landed', landedBy: { type: 'pr' } })
  })
})
