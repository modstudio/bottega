// concern: review-funnel verdict service
/** Runs the canonical gather-and-decide path for one already-resolved change. */

import { decideReviewFunnel } from './decide-review-funnel.ts'
import { gatherFunnelFacts, type ReviewFunnelChange } from './gather-funnel-facts.ts'
import { activeReviewFunnelPolicy } from './review-funnel-policy.ts'

export type ReviewFunnelVerdictForChange =
  | { kind: 'empty'; commit: string; base: string }
  | {
      kind: 'measured'
      facts: ReturnType<typeof gatherFunnelFacts>
      verdict: ReturnType<typeof decideReviewFunnel>
    }

export async function reviewFunnelVerdictForChange(
  change: Omit<ReviewFunnelChange, 'selectionWindow'>,
): Promise<ReviewFunnelVerdictForChange> {
  if (change.head === change.base) {
    return { kind: 'empty', commit: change.head, base: change.base }
  }
  const active = await activeReviewFunnelPolicy()
  const facts = gatherFunnelFacts({
    ...change,
    selectionWindow: active.policy.selection.window,
  })
  return {
    kind: 'measured',
    facts,
    verdict: decideReviewFunnel(facts, active.policy, active.policyVersion),
  }
}
