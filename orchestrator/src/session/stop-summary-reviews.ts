// concern: session stop summary review classification
/** Classifies review rounds from plain lens-run facts. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RUN_LIVE_STATUSES, TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import type { StopSummaryOwedItem } from './stop-summary-decision.ts'

export type StopSummaryReviewLensRow = {
  review_record_id: string
  number: number
  completed_at: string | null
  outdated_at: string | null
  run_status: string
  finished_at: string
  open_findings: number
}

type ReviewClassification = {
  incompleteReviews: number
  owedItems: StopSummaryOwedItem[]
}

const LIVE_RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_LIVE_STATUSES)

export function classifyStopSummaryReviews(
  rows: readonly StopSummaryReviewLensRow[],
): ReviewClassification {
  const reviews = new Map<string, StopSummaryReviewLensRow[]>()
  for (const row of rows) {
    const lenses = reviews.get(row.review_record_id)
    if (lenses) lenses.push(row)
    else reviews.set(row.review_record_id, [row])
  }

  let incompleteReviews = 0
  const owedItems: StopSummaryOwedItem[] = []
  for (const lenses of reviews.values()) {
    if (lenses.some((lens) => LIVE_RUN_STATUS_SET.has(lens.run_status))) {
      incompleteReviews += 1
      continue
    }
    const review = lenses[0]
    if (!review) continue
    if (
      review.completed_at !== null ||
      review.outdated_at !== null ||
      !lenses.every((lens) => TERMINAL_RUN_STATUS_SET.has(lens.run_status))
    )
      continue
    const owedAt = lenses.reduce(
      (latest, lens) => (lens.finished_at > latest ? lens.finished_at : latest),
      review.finished_at,
    )
    owedItems.push({
      kind: 'review',
      identity: review.review_record_id,
      label: `review ${review.number} untriaged (${review.open_findings} findings open)`,
      command: `${PLATFORM_SLUG} review show ${review.number}`,
      owedAt,
    })
  }
  return { incompleteReviews, owedItems }
}
