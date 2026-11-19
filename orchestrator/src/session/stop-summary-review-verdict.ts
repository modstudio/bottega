// concern: session review verdict summary decision
/** Renders at most one review-funnel obligation line for one in-flight branch. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ReviewFunnelVerdict } from '../review-funnel/decide-review-funnel.ts'

type ReviewVerdictFields = Pick<ReviewFunnelVerdict, 'change' | 'lenses' | 'next'>

export type StopSummaryReviewVerdictFact = {
  branch: string
  taskKey: string | null
  verdict?: ReviewVerdictFields
  failure?: string
}

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()

/** A satisfied or waived branch has no line; an owed branch has one compact remedy. */
export function stopSummaryReviewVerdictLine(fact: StopSummaryReviewVerdictFact): string | null {
  const label = fact.taskKey ?? fact.branch
  if (fact.failure) {
    return `${label}: review verdict unavailable (${oneLine(fact.failure)}) → ${PLATFORM_SLUG} review tier ${label}`
  }
  const verdict = fact.verdict
  if (!verdict) return null
  if (verdict.lenses.some((lens) => lens.status === 'running' || lens.status === 'building'))
    return null
  const owed = verdict.lenses.filter((lens) => lens.status === 'owed')
  if (owed.length) {
    const noun = owed.length === 1 ? 'lens' : 'lenses'
    return `${label}: ${owed.length} review ${noun} owed → ${PLATFORM_SLUG} review tier ${label}`
  }
  if (verdict.next.action === 'record-read') {
    return `${label}: architect read owed → ${PLATFORM_SLUG} review read --sha ${verdict.change.head} --note "<what was read and why it lands>"`
  }
  return null
}

export function stopSummaryReviewVerdictLines(
  facts: readonly StopSummaryReviewVerdictFact[],
): string[] {
  return facts.map(stopSummaryReviewVerdictLine).filter((line): line is string => line !== null)
}
