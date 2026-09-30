// concern: branches
/** Matches run branches needing a landing record to already-listed merged pull requests. */

import type { PullRequestLandingEvidence } from './branch-landing-record.ts'

export type BranchLandingCandidate = {
  branch: string
  hasLandingRecord: boolean
}

export type BranchLandingMatch = {
  branch: string
  pullRequest: PullRequestLandingEvidence
}

/** Match exact PR heads and choose the most recently merged PR for each eligible branch. */
export function matchBranchLandings(
  candidates: readonly BranchLandingCandidate[],
  pullRequests: readonly PullRequestLandingEvidence[],
): BranchLandingMatch[] {
  return candidates.flatMap((candidate) => {
    if (candidate.hasLandingRecord) return []
    const pullRequest = pullRequests
      .filter(
        (row) =>
          row.headRefName === candidate.branch && row.state === 'MERGED' && row.mergedAt !== null,
      )
      .sort((left, right) => right.mergedAt!.localeCompare(left.mergedAt!))[0]
    return pullRequest ? [{ branch: candidate.branch, pullRequest }] : []
  })
}
