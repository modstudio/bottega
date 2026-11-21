// concern: review-evidence-sql
import { voidedSql } from '../evidence/evidence-query.ts'
import type { ReviewSettings } from '../project/project-injection.ts'

export const REVIEW_WINDOW = 50

/** A finding disposition counted as accepted review evidence. */
export function acceptedReviewFindingSql(findingAlias = 'finding'): string {
  return `${findingAlias}.disposition IN ('accepted','modified')`
}

/** Accepted review evidence that is not recorded as a duplicate. */
export function uniqueReviewFindingSql(findingAlias = 'finding'): string {
  return `${acceptedReviewFindingSql(findingAlias)}
    AND ${findingAlias}.duplicate_of_finding_record_id IS NULL`
}

/** A finding disposition counted in the denominator for reviewer precision. */
export function triagedReviewFindingSql(findingAlias = 'finding'): string {
  return `${findingAlias}.disposition IN ('accepted','modified','rejected')`
}

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

/** Does this lens run count as routing evidence? */
export function routingReviewRunEvidenceSql(runAlias = 'run', lensAlias = 'rl'): string {
  return `NOT (${voidedSql(runAlias)})
    AND COALESCE(${runAlias}.probe, 0) = 0
    AND NOT EXISTS (SELECT 1 FROM score review_score
      WHERE review_score.run_record_id=${lensAlias}.run_record_id AND review_score.delivery='none')`
}

/** Does this lens run count as review-admission evidence? */
export function admissionReviewRunEvidenceSql(runAlias = 'run', lensAlias = 'rl'): string {
  return `COALESCE(${runAlias}.probe, 0) = 0
    AND ((${routingReviewRunEvidenceSql(runAlias, lensAlias)})
      OR ((${voidedSql(runAlias)})
        AND EXISTS (SELECT 1 FROM review_finding admission_finding
          WHERE admission_finding.review_lens_record_id=${lensAlias}.record_id
            AND admission_finding.disposition IS NOT NULL)))`
}

/** Does this completed review count as evidence for the named consumer class? */
export function completedReviewEvidenceSql(
  form: 'admission' | 'routing',
  reviewAlias = 'r',
  runAlias = 'run',
  lensAlias = 'rl',
): string {
  return `${reviewAlias}.completed_at IS NOT NULL
    AND ${
      form === 'admission'
        ? admissionReviewRunEvidenceSql(runAlias, lensAlias)
        : routingReviewRunEvidenceSql(runAlias, lensAlias)
    }`
}
