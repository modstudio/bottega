import { describe, expect, test } from 'bun:test'
import {
  decideAutomaticBranchLandingTip,
  matchAutomaticBranchLandingForTip,
  matchBranchLandings,
} from './branch-landing-match.ts'
import type { PullRequestLandingEvidence } from './branch-landing-record.ts'
import { decideBranchState, decidePruneEligibility } from './branch-state.ts'
import type { MergedPullRequest } from './merged-pull-request.ts'

function pullRequest(
  number: number,
  headRefName: string,
  overrides: Partial<PullRequestLandingEvidence> = {},
): PullRequestLandingEvidence {
  return {
    number,
    state: 'MERGED',
    title: `${headRefName} change`,
    headRefName,
    headRefOid: `head-${number}`,
    mergeCommit: { oid: `merge-${number}` },
    mergedAt: `2026-09-${String(number).padStart(2, '0')}T12:00:00Z`,
    ...overrides,
  }
}

describe('branch landing matching', () => {
  test('matches an exact headRefName', () => {
    const matched = matchBranchLandings(
      [{ branch: 'DEV-1049-orch-7636', hasLandingRecord: false }],
      [pullRequest(1, 'DEV-1049-orch-7636')],
    )

    expect(matched.map(({ branch, pullRequest: row }) => [branch, row.number])).toEqual([
      ['DEV-1049-orch-7636', 1],
    ])
  })

  test('does not match a different headRefName', () => {
    expect(
      matchBranchLandings(
        [{ branch: 'DEV-1049-orch-7636', hasLandingRecord: false }],
        [pullRequest(1, 'DEV-1049-orch-elsewhere')],
      ),
    ).toEqual([])
  })

  test('ignores an unmerged PR and chooses the latest of several merged PRs', () => {
    const branch = 'DEV-1049-orch-7636'
    const matched = matchBranchLandings(
      [{ branch, hasLandingRecord: false }],
      [
        pullRequest(3, branch, { state: 'OPEN', mergedAt: null }),
        pullRequest(1, branch, { mergedAt: '2026-09-01T12:00:00Z' }),
        pullRequest(2, branch, { mergedAt: '2026-09-02T12:00:00Z' }),
      ],
    )

    expect(matched[0]?.pullRequest.number).toBe(2)
  })

  test('skips a candidate that already has a landing record', () => {
    expect(
      matchBranchLandings(
        [{ branch: 'DEV-1049-orch-7636', hasLandingRecord: true }],
        [pullRequest(1, 'DEV-1049-orch-7636')],
      ),
    ).toEqual([])
  })
})

describe('automatic branch landing tip decision', () => {
  test('records when the local tip equals the PR head', () => {
    expect(decideAutomaticBranchLandingTip('same123', 'same123')).toEqual({
      action: 'record',
      tip: 'same123',
    })
  })

  test('records the PR head when the local branch is absent', () => {
    expect(decideAutomaticBranchLandingTip(null, 'head123')).toEqual({
      action: 'record',
      tip: 'head123',
    })
  })

  test('skips and identifies both tips when the local branch advanced', () => {
    expect(decideAutomaticBranchLandingTip('advanced456', 'head123')).toEqual({
      action: 'skip',
      reason: 'local tip advanced456 differs from PR head head123',
    })
  })

  test('an advanced branch stays unlanded and ineligible for prune', () => {
    const branch = 'DEV-1049-orch-7636'
    const merged = pullRequest(1, branch, { headRefOid: 'merged123' }) as MergedPullRequest
    const matching = matchAutomaticBranchLandingForTip(branch, 'advanced456', [merged])
    const state = decideBranchState({
      branch,
      tip: 'advanced456',
      mergedPullRequests: matching ? [merged] : [],
      mergedPullRequestsTruncated: false,
      commitsNotOnTrunk: 1,
      patchEquivalent: null,
      pullRequestCommitCheck: null,
      recordedLanding: null,
      laterTurnBranches: [],
      superseded: false,
    })

    expect(matching).toBeNull()
    expect(state).toEqual({ state: 'unlanded' })
    expect(
      decidePruneEligibility({
        state: state.state,
        checkedOut: false,
        liveRun: false,
        tipMoved: false,
      }),
    ).toEqual({ eligible: false, reason: 'state' })
  })
})
