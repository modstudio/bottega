// concern: review-evidence-sql
import { voidedSql } from './evidence-query.ts'

export const REVIEW_WINDOW = 50

/** A recorded lens run eligible to become review evidence. */
export function reviewRunEvidenceSql(runAlias = 'run', lensAlias = 'rl'): string {
  return `NOT (${voidedSql(runAlias)})
    AND COALESCE(${runAlias}.probe, 0) = 0
    AND NOT EXISTS (SELECT 1 FROM score review_score
      WHERE review_score.run_id=${lensAlias}.run_id AND review_score.delivery='none')`
}

/** The complete-review boundary consumed by calibration and review reports. */
export function completedReviewEvidenceSql(
  reviewAlias = 'r', runAlias = 'run', lensAlias = 'rl',
): string {
  return `${reviewAlias}.completed_at IS NOT NULL
    AND ${reviewRunEvidenceSql(runAlias, lensAlias)}`
}
