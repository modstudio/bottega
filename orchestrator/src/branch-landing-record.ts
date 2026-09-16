// concern: branch-landing-record
/** Validates GitHub evidence before a reworked run branch is recorded as landed. */

export type PullRequestLandingEvidence = {
  number: number
  state: string
  title: string
  mergeCommit: { oid: string } | null
  mergedAt: string | null
}

type VerifiedBranchLanding = {
  number: number
  mergeCommit: string | null
  mergedAt: string
}

type LandingVerification =
  | { accepted: true; landing: VerifiedBranchLanding }
  | { accepted: false; reason: string }

/** A key matches only as a whole key: DEV-61 does not match a title naming DEV-617. */
function titleNamesTaskKey(title: string, taskKey: string): boolean {
  const escaped = taskKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}(?![A-Za-z0-9])`).test(title)
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
  if (!titleNamesTaskKey(pullRequest.title, taskKey)) {
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
