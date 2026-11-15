// concern: review-funnel verdict service
/** Runs the canonical gather-and-decide path for one already-resolved change. */

import { decideReviewFunnel } from './decide-review-funnel.ts'
import { gatherFunnelFacts, type ReviewFunnelChange } from './gather-funnel-facts.ts'
import { activeReviewFunnelPolicy } from './review-funnel-policy.ts'

export function reviewFunnelVerdictForChange(change: Omit<ReviewFunnelChange, 'selectionWindow'>) {
  const active = activeReviewFunnelPolicy()
  const facts = gatherFunnelFacts({
    ...change,
    selectionWindow: active.policy.selection.window,
  })
  return {
    facts,
    verdict: decideReviewFunnel(facts, active.policy, active.policyVersion),
  }
}
