// concern: workflow-review-owed-decision
/** Pure review-owed floor decision. Must not know stores, processes, or clocks. */

import type { ReviewFunnelLensStatus } from '../review-funnel/decide-review-funnel.ts'

type ReviewOwedVerdict = {
  lenses: readonly {
    lens: string
    status: ReviewFunnelLensStatus
  }[]
  remedy: string
}

export type ReviewOwedFloorDecision = { action: 'allow' } | { action: 'refuse'; message: string }

const BLOCKING_LENS_STATUSES: ReadonlySet<ReviewFunnelLensStatus> = new Set([
  'owed',
  'running',
  'untriaged',
])

export function decideReviewOwedFloor(verdict: ReviewOwedVerdict): ReviewOwedFloorDecision {
  const blocking = verdict.lenses.filter(({ status }) => BLOCKING_LENS_STATUSES.has(status))
  if (!blocking.length) return { action: 'allow' }
  return {
    action: 'refuse',
    message: `floor review-owed is unmet; blocking lenses: ${blocking.map(({ lens, status }) => `${lens} (${status})`).join(', ')}; remedy: \`${verdict.remedy}\``,
  }
}
