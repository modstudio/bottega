// concern: workflow-review-owed-decision
/** Pure review-owed floor decision. Must not know stores, processes, or clocks. */

type ReviewOwedVerdict = {
  lenses: readonly {
    lens: string
    status:
      | 'owed'
      | 'running'
      | 'untriaged'
      | 'satisfied'
      | 'credited-by-read'
      | 'not-applicable'
      | 'waived-at-ceiling'
      | 'overridden'
  }[]
  remedy: string
}

export type ReviewOwedFloorDecision = { action: 'allow' } | { action: 'refuse'; message: string }

export function decideReviewOwedFloor(verdict: ReviewOwedVerdict): ReviewOwedFloorDecision {
  const owed = verdict.lenses.filter(({ status }) => status === 'owed').map(({ lens }) => lens)
  if (!owed.length) return { action: 'allow' }
  return {
    action: 'refuse',
    message: `floor review-owed is unmet; owed lenses: ${owed.join(', ')}; remedy: \`${verdict.remedy}\``,
  }
}
