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
  const blocking = verdict.lenses.filter(({ status }) =>
    ['owed', 'running', 'untriaged'].includes(status),
  )
  if (!blocking.length) return { action: 'allow' }
  return {
    action: 'refuse',
    message: `floor review-owed is unmet; blocking lenses: ${blocking.map(({ lens, status }) => `${lens} (${status})`).join(', ')}; remedy: \`${verdict.remedy}\``,
  }
}
