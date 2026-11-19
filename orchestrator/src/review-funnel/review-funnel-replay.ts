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
  const selectionNotExercised = rows
    .filter((row) => row.facts.yieldCells === undefined)
    .map(({ recordId }) => recordId)
  const diffs = rows.flatMap((row) => {
    const after = decideReviewFunnel(row.facts, candidate.policy, candidate.policyVersion)
    const normalizedBefore: ReviewFunnelVerdict = {
      policyVersion: candidate.policyVersion,
      mode: row.verdict.mode,
      change: row.verdict.change,
      ...(row.verdict.liveWriter ? { liveWriter: row.verdict.liveWriter } : {}),
      tier: row.verdict.tier,
      budget: row.verdict.budget,
      selection: row.verdict.selection ?? {
        mode: candidate.policy.modes.selection,
        lenses: [],
      },
      lenses: row.verdict.lenses,
      next: row.verdict.next,
      remedy: row.verdict.remedy,
    }
    return JSON.stringify(normalizedBefore) === JSON.stringify(after)
      ? []
      : [{ recordId: row.recordId, before: row.verdict, after }]
  })
  return { diffs, selectionNotExercised }
}
