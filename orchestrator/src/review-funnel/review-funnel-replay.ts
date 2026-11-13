// concern: review-funnel-replay
/** Replays plain logged facts through a candidate policy and returns changed verdicts. */
import {
  decideReviewFunnel,
  type ReviewFunnelFacts,
  type ReviewFunnelVerdict,
} from './decide-review-funnel.ts'
import type { ReviewFunnelPolicy } from './review-funnel-policy.ts'

export function replayReviewFunnelRows(
  rows: readonly { recordId: string; facts: ReviewFunnelFacts; verdict: ReviewFunnelVerdict }[],
  candidate: { policy: ReviewFunnelPolicy; version: string },
) {
  return rows.flatMap((row) => {
    const after = decideReviewFunnel(row.facts, candidate.policy, candidate.version)
    const normalizedBefore = { ...row.verdict, policyVersion: candidate.version }
    return JSON.stringify(normalizedBefore) === JSON.stringify(after)
      ? []
      : [{ recordId: row.recordId, before: row.verdict, after }]
  })
}
