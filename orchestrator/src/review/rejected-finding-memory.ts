// concern: review
/** Reads the plain review rows used to carry earlier rejection rulings into later lenses. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'

export type ReviewFindingMemory = {
  project: string
  branch: string | null
  rows: readonly {
    project: string
    branch: string | null
    reviewId: number
    completedAt: string | null
    ordinal: number
    disposition: string | null
    location: string
    evidence: string
    rejectionCategory: string | null
    triageReason: string | null
    lens: string
    reviewedCommit: string | null
  }[]
}

/** Review findings for one project; branch, completion, disposition, and bounds are decided purely. */
export function reviewFindingMemoryRows(
  project: string,
  database: Database = db(),
): ReviewFindingMemory['rows'] {
  return database
    .query<
      {
        project: string
        branch: string | null
        review_id: number
        completed_at: string | null
        ordinal: number
        disposition: string | null
        location: string
        evidence: string
        rejection_category: string | null
        triage_reason: string | null
        lens: string
        reviewed_commit: string | null
      },
      [string]
    >(
      `SELECT run.repo project,run.branch,r.id review_id,r.completed_at,rf.ordinal,
              rf.disposition,rf.location,rf.evidence,rf.rejection_category,rl.lens,
              run.head_commit reviewed_commit,
              (SELECT amendment.reason FROM review_finding_amendment amendment
                WHERE amendment.review_id=rf.review_id
                  AND amendment.finding_ordinal=rf.ordinal
                ORDER BY amendment.at DESC,amendment.rowid DESC LIMIT 1) triage_reason
         FROM review_finding rf
         JOIN review r ON r.id=rf.review_id
         JOIN review_lens rl ON rl.id=rf.review_lens_id
         JOIN run ON run.id=rl.run_id
        WHERE run.repo=?`,
    )
    .all(project)
    .map((row) => ({
      project: row.project,
      branch: row.branch,
      reviewId: row.review_id,
      completedAt: row.completed_at,
      ordinal: row.ordinal,
      disposition: row.disposition,
      location: row.location,
      evidence: row.evidence,
      rejectionCategory: row.rejection_category,
      triageReason: row.triage_reason,
      lens: row.lens,
      reviewedCommit: row.reviewed_commit,
    }))
}
