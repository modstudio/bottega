// concern: review-round-backfill
/** Backfills historical review round identity without holding a long-lived write lock. */

import type { Database } from 'bun:sqlite'
import { writeTransaction } from '../database/db.ts'
import { enqueueReview } from './review-outbox.ts'
import { reviewRoundForRecording } from './review-round-identity.ts'

type PendingReviewRound = {
  record_id: string
  project: string
  role: 'round'
  patch_id: string | null
  path_set: string | null
  launch_key: string | null
  branch: string
}

/**
 * Compute ordinals under read access, then commit each changed review and its
 * replacement outbox graph in a short transaction. Unclassifiable rows remain null.
 */
export function backfillReviewRounds(database: Database): number {
  const pending = database
    .query<PendingReviewRound, []>(
      `SELECT r.record_id,p.name AS project,r.role,r.patch_id,r.path_set,run.launch_key,run.branch
         FROM review r
         JOIN review_lens rl ON rl.review_record_id=r.record_id
         JOIN run ON run.record_id=rl.run_record_id
         JOIN project p ON p.record_id=run.project_record_id
        WHERE r.role='round' AND r.round IS NULL AND run.branch IS NOT NULL
        ORDER BY r.recorded_at,r.number,run.number,rl.record_id`,
    )
    .all()
  const seen = new Set<string>()
  const classified: { recordId: string; round: number }[] = []
  for (const row of pending) {
    if (seen.has(row.record_id)) continue
    seen.add(row.record_id)
    const round = reviewRoundForRecording(database, row)
    if (round !== null) classified.push({ recordId: row.record_id, round })
  }

  let changed = 0
  for (const row of classified) {
    changed += writeTransaction(() => {
      const result = database
        .query('UPDATE review SET round=? WHERE record_id=? AND round IS NULL')
        .run(row.round, row.recordId)
      if (result.changes) enqueueReview(database, row.recordId)
      return result.changes
    }, database)
  }
  return changed
}
