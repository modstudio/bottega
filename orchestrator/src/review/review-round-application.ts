// concern: review round application
/** Decides and gathers whether a findings continuation already applied a review round. */

import type { Database } from 'bun:sqlite'
import type { ChangeGroup, TriageReviewRow } from './review-group.ts'
import { reviewTaskKeyForBranch } from './review-group.ts'
import { reviewLineage } from './review-lineage-store.ts'

export type AppliedFindingsTurn = { startedAt: string }

/** Whether a qualifying findings turn started after the round's last recorded review. */
export function reviewRoundWasApplied(
  latestReviewRecordedAt: string,
  turns: readonly AppliedFindingsTurn[],
): boolean {
  const threshold = Date.parse(latestReviewRecordedAt)
  return turns.some(({ startedAt }) => Date.parse(startedAt) > threshold)
}

/** Gather qualifying same-task lineage turns and delegate the timestamp decision. */
export function continuationReviewsWereApplied(
  database: Database,
  group: ChangeGroup,
  reviews: readonly TriageReviewRow[],
): boolean {
  if (!reviews.length) return false
  const taskKey = reviewTaskKeyForBranch(database, group.project, group.branch)
  if (!taskKey) return false
  const lineage = reviewLineage(database, group.project, group.branch)
  const turns = database
    .query<{ started_at: string }, string[]>(
      `SELECT started_at FROM run
        WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND job='implement' AND status='ok' AND continued_with_findings=1
          AND upper(trim(launch_key))=?
          AND branch IN (${lineage.map(() => '?').join(',')})`,
    )
    .all(group.project, taskKey, ...lineage)
    .map(({ started_at }) => ({ startedAt: started_at }))
  const latestReviewRecordedAt = reviews.reduce(
    (latest, review) => (review.recordedAt > latest ? review.recordedAt : latest),
    reviews[0]!.recordedAt,
  )
  return reviewRoundWasApplied(latestReviewRecordedAt, turns)
}
