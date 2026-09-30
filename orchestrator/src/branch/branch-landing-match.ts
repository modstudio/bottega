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

export type AutomaticBranchLandingTipDecision =
  | { action: 'record'; tip: string }
  | { action: 'skip'; reason: string }

/** Only automatic repair requires the current branch tip to be the merged PR head. */
export function decideAutomaticBranchLandingTip(
  localTip: string | null,
  prHeadOid: string,
): AutomaticBranchLandingTipDecision {
  if (localTip === null) return { action: 'record', tip: prHeadOid }
  if (localTip === prHeadOid) return { action: 'record', tip: localTip }
  return {
    action: 'skip',
    reason: `local tip ${localTip} differs from PR head ${prHeadOid}`,
  }
}

/** Return the latest name match only when it is evidence for the branch's current tip. */
export function matchAutomaticBranchLandingForTip(
  branch: string,
  localTip: string,
  pullRequests: readonly PullRequestLandingEvidence[],
): BranchLandingMatch | null {
  const match = matchBranchLandings([{ branch, hasLandingRecord: false }], pullRequests)[0]
  if (!match || match.pullRequest.headRefOid === null) return null
  return decideAutomaticBranchLandingTip(localTip, match.pullRequest.headRefOid).action === 'record'
    ? match
    : null
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
