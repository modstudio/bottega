import { describe, expect, test } from 'bun:test'
import type { PullRequestLandingEvidence } from './branch-landing-record.ts'
import { matchBranchLandings } from './branch-landing-service.ts'

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
