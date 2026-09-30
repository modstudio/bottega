// concern: branch-landing-record
/** Validates GitHub evidence before a reworked run branch is recorded as landed. */

import { pullRequestCarriesKey } from './branch-state.ts'

export type PullRequestLandingEvidence = {
  number: number
  state: string
  title: string
  headRefName: string
  headRefOid: string | null
  mergeCommit: { oid: string } | null
  mergedAt: string | null
}

export type BranchLandingTipChoice =
  | { accepted: true; tip: string; source: 'local'; differsFromPrHead: boolean }
  | { accepted: true; tip: string; source: 'pull-request'; differsFromPrHead: false }
  | { accepted: false }

type VerifiedBranchLanding = {
  number: number
  mergeCommit: string | null
  mergedAt: string
}

type LandingVerification =
  | { accepted: true; landing: VerifiedBranchLanding }
  | { accepted: false; reason: string }

export function chooseBranchLandingTip(
  localTip: string | null,
  prHeadOid: string | null,
): BranchLandingTipChoice {
  if (localTip !== null) {
    return {
      accepted: true,
      tip: localTip,
      source: 'local',
      differsFromPrHead: prHeadOid !== null && localTip !== prHeadOid,
    }
  }
  if (prHeadOid !== null) {
    return { accepted: true, tip: prHeadOid, source: 'pull-request', differsFromPrHead: false }
  }
  return { accepted: false }
}

export function verifyBranchLanding(
  taskKey: string,
  pullRequest: PullRequestLandingEvidence,
): LandingVerification {
  if (pullRequest.state !== 'MERGED' || pullRequest.mergedAt === null) {
    return {
      accepted: false,
      reason: `PR #${pullRequest.number} is not merged`,
    }
  }
  if (!pullRequestCarriesKey(pullRequest, taskKey)) {
    return {
      accepted: false,
      reason: `PR #${pullRequest.number} carries task key neither in its title nor in its head branch: ${taskKey}`,
    }
  }
  return {
    accepted: true,
    landing: {
      number: pullRequest.number,
      mergeCommit: pullRequest.mergeCommit?.oid ?? null,
      mergedAt: pullRequest.mergedAt,
    },
  }
}
