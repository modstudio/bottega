// concern: branch-landing-record
/** Validates GitHub evidence before a reworked run branch is recorded as landed. */

export type PullRequestLandingEvidence = {
  number: number
  state: string
  title: string
  mergeCommit: { oid: string } | null
  mergedAt: string | null
}

export type VerifiedBranchLanding = {
  number: number
  mergeCommit: string | null
  mergedAt: string
}

type LandingVerification =
  | { accepted: true; landing: VerifiedBranchLanding }
  | { accepted: false; reason: string }

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
  if (!pullRequest.title.includes(taskKey)) {
    return {
      accepted: false,
      reason: `PR #${pullRequest.number} title does not contain task key ${taskKey}`,
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
