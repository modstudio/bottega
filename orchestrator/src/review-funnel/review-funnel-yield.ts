// concern: review-funnel-yield
/** Reads and applies the measured lens-yield cells used by funnel selection. */

import type { Database } from 'bun:sqlite'
import {
  acceptedReviewFindingSql,
  completedReviewEvidenceSql,
  triagedReviewFindingSql,
  uniqueReviewFindingSql,
} from '../review/review-evidence-sql.ts'

export type ReviewFunnelYieldCell = {
  lens: string
  stack: string | null
  tier: 0 | 1 | 2 | 3
  accepted: number
  unique: number
  triaged: number
}

/** Read the most recent complete, eligible lens rows in each lens/stack/tier cell. */
export function reviewFunnelYieldCells(
  database: Database,
  window: number,
): ReviewFunnelYieldCell[] {
  return database
    .query<ReviewFunnelYieldCell, [number]>(
      `WITH ranked_lenses AS (
         SELECT rl.record_id AS review_lens_record_id,rl.lens,run.stack,r.tier,
                ROW_NUMBER() OVER (
                  PARTITION BY rl.lens,run.stack,r.tier
                  ORDER BY r.completed_at DESC,r.number DESC,rl.record_id DESC
                ) AS recency
           FROM review_lens rl
           JOIN review r ON r.record_id=rl.review_record_id
           JOIN run ON run.record_id=rl.run_record_id
          WHERE r.tier IN (0,1,2,3) AND ${completedReviewEvidenceSql('routing', 'r', 'run', 'rl')}
       )
       SELECT ranked.lens,ranked.stack,ranked.tier,
              COALESCE(SUM(CASE WHEN ${acceptedReviewFindingSql()} THEN 1 ELSE 0 END),0) AS accepted,
              COALESCE(SUM(CASE WHEN ${uniqueReviewFindingSql()} THEN 1 ELSE 0 END),0) AS "unique",
              COALESCE(SUM(CASE WHEN ${triagedReviewFindingSql()} THEN 1 ELSE 0 END),0) AS triaged
         FROM ranked_lenses ranked
         LEFT JOIN review_finding finding
           ON finding.review_lens_record_id=ranked.review_lens_record_id
        WHERE ranked.recency<=?
        GROUP BY ranked.lens,ranked.stack,ranked.tier
        ORDER BY ranked.lens,ranked.stack,ranked.tier`,
    )
    .all(window)
}
