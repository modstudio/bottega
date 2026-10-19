// concern: review
/** Reads the plain review rows used to carry earlier rejection rulings into later lenses. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import type { ReviewFindingMemory } from '../dispatch/review-memory.ts'

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
        review_record_id: string
        review_number: number
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
      `SELECT run.repo project,run.branch,r.record_id review_record_id,r.number review_number,
              r.completed_at,rf.ordinal,
              rf.disposition,rf.location,rf.evidence,rf.rejection_category,rl.lens,
              run.head_commit reviewed_commit,
              (SELECT amendment.reason FROM review_finding_amendment amendment
                WHERE amendment.review_finding_record_id=rf.record_id
                ORDER BY amendment.at DESC,amendment.rowid DESC LIMIT 1) triage_reason
         FROM review_finding rf
         JOIN review r ON r.record_id=rf.review_record_id
         JOIN review_lens rl ON rl.record_id=rf.review_lens_record_id
         JOIN run ON run.record_id=rl.run_record_id
        WHERE run.project_record_id=(SELECT record_id FROM project WHERE name=?)`,
    )
    .all(project)
    .map((row) => ({
      project: row.project,
      branch: row.branch,
      reviewRecordId: row.review_record_id,
      reviewNumber: row.review_number,
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
