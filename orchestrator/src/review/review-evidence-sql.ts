// concern: review-evidence-sql
import { voidedSql } from '../evidence/evidence-query.ts'
import type { ReviewSettings } from '../project/project-injection.ts'

export const REVIEW_WINDOW = 50

/** Parse a stored project's review declaration without inventing one on malformed data. */
export function parseStoredReviewSettings(value: string | null): ReviewSettings | undefined {
  if (!value) return undefined
  try {
    const review = (JSON.parse(value) as { review?: ReviewSettings }).review
    return review && Array.isArray(review.lenses) ? review : undefined
  } catch {
    return undefined
  }
}

/** Parse a recorded path set, preserving absent or malformed data as unrecorded. */
export function parseStoredReviewPathSet(value: string | null): string[] | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && parsed.every((path) => typeof path === 'string') ? parsed : null
  } catch {
    return null
  }
}

/** A recorded lens run eligible to become review evidence. */
export function reviewRunEvidenceSql(runAlias = 'run', lensAlias = 'rl'): string {
  return `NOT (${voidedSql(runAlias)})
    AND COALESCE(${runAlias}.probe, 0) = 0
    AND NOT EXISTS (SELECT 1 FROM score review_score
      WHERE review_score.run_record_id=${lensAlias}.run_record_id AND review_score.delivery='none')`
}

/** The complete-review boundary consumed by calibration and review reports. */
export function completedReviewEvidenceSql(
  reviewAlias = 'r',
  runAlias = 'run',
  lensAlias = 'rl',
): string {
  return `${reviewAlias}.completed_at IS NOT NULL
    AND ${reviewRunEvidenceSql(runAlias, lensAlias)}`
}
