// concern: review-funnel-replay
/** Replays plain logged facts through a candidate policy and returns changed verdicts. */
import {
  decideReviewFunnel,
  type ReviewFunnelFacts,
  type ReviewFunnelVerdict,
} from './decide-review-funnel.ts'
import type { VersionedReviewFunnelPolicy } from './review-funnel-policy.ts'

export function replayReviewFunnelRows(
  rows: readonly { recordId: string; facts: ReviewFunnelFacts; verdict: ReviewFunnelVerdict }[],
  candidate: VersionedReviewFunnelPolicy,
) {
  return rows.flatMap((row) => {
    const after = decideReviewFunnel(row.facts, candidate.policy, candidate.policyVersion)
    const normalizedBefore = { ...row.verdict, policyVersion: candidate.policyVersion }
    return JSON.stringify(normalizedBefore) === JSON.stringify(after)
      ? []
      : [{ recordId: row.recordId, before: row.verdict, after }]
  })
}
