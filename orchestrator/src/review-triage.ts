// concern: review-triage
import type { Database } from 'bun:sqlite'
import { nowIso, writableDb } from './db.ts'
import {
  REVIEW_SEVERITY,
  type ReviewCoverage,
  type ReviewLimits,
  type ReviewOverlap,
  type ReviewReproduced,
  type ReviewSeverity,
} from './review-vocabulary.ts'
import type { ReviewReply } from './contract.ts'
import { recordReviews } from './review.ts'

/**
 * Initial safety floor. Re-set this from the observed triage distribution once
 * this repository has enough review data; until then the conservative value
 * prevents a handful of findings from changing reviewer behaviour.
 */
export const MIN_REVIEW_TRIAGED = 10

export const DISPOSITIONS = ['accepted', 'modified', 'rejected', 'skipped'] as const
export type Disposition = (typeof DISPOSITIONS)[number]

export type ReviewTriageBag = {
  total: number
  triaged: number
  untriaged: number
  accepted: number
  modified: number
  rejected: number
  skipped: number
  hits: number
}

export function reviewTriageBag(rows: readonly { disposition: string | null }[]): ReviewTriageBag {
  const count = (disposition: Disposition) =>
    rows.filter((row) => row.disposition === disposition).length
  const accepted = count('accepted')
  const modified = count('modified')
  const rejected = count('rejected')
  const skipped = count('skipped')
  return {
    total: rows.length,
    triaged: accepted + modified + rejected + skipped,
    untriaged: rows.filter((row) => row.disposition === null).length,
    accepted,
    modified,
    rejected,
    skipped,
    hits: accepted + modified,
  }
}

export type ReviewGrades = {
  reproduced: ReviewReproduced
  coverage: ReviewCoverage
  limits: ReviewLimits
  overlap: ReviewOverlap
}

export function recordReview(runId: number, output: ReviewReply, database: Database): number {
  return recordReviews([{ runId, output }], database)
}

export function gradeReviewLens(
  runId: number,
  output: ReviewReply | null,
  grades: ReviewGrades,
  database: Database = writableDb(),
): number {
  let row = database.query('SELECT id, review_id FROM review_lens WHERE run_id=?').get(runId) as {
    id: number
    review_id: number
  } | null
  if (!row) {
    if (!output) throw new Error(`run ${runId} has no review output to record`)
    // The scoring path records through recordReview so it shares the same
    // best-effort commit pinning as `orch review record`.
    const reviewId = recordReview(runId, output, database)
    row = database.query('SELECT id, review_id FROM review_lens WHERE run_id=?').get(runId) as {
      id: number
      review_id: number
    }
    if (row.review_id !== reviewId) throw new Error(`run ${runId} review capture did not persist`)
  }
  database
    .query(`UPDATE review_lens SET reproduced=?, coverage=?, limits=?, overlap=? WHERE id=?`)
    .run(grades.reproduced, grades.coverage, grades.limits, grades.overlap, row.id)
  return row.review_id
}

export function triageFinding(
  reviewId: number,
  ordinal: number,
  disposition: Disposition,
  rejectionCategory?: string,
  triagedSeverity?: string,
  database: Database = writableDb(),
): void {
  if (!DISPOSITIONS.includes(disposition)) throw new Error(`invalid disposition: ${disposition}`)
  if (disposition === 'rejected' && !rejectionCategory?.trim()) {
    throw new Error('a rejected finding requires --category')
  }
  if (rejectionCategory && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(rejectionCategory)) {
    throw new Error('rejection category must be a lowercase stable id of at most 64 characters')
  }
  const review = database.query('SELECT completed_at FROM review WHERE id=?').get(reviewId) as {
    completed_at: string | null
  } | null
  if (!review) throw new Error(`no review ${reviewId}`)
  if (review.completed_at) throw new Error(`review ${reviewId} is already complete`)
  const finding = database
    .query('SELECT severity FROM review_finding WHERE review_id=? AND ordinal=?')
    .get(reviewId, ordinal) as { severity: string } | null
  if (!finding) throw new Error(`review ${reviewId} has no finding ${ordinal}`)
  const severity = triagedSeverity?.trim()
  if (severity && !REVIEW_SEVERITY.includes(severity as ReviewSeverity)) {
    throw new Error(`severity must be: ${REVIEW_SEVERITY.join(' | ')}`)
  }
  const result = database
    .query(
      `UPDATE review_finding SET disposition=?, rejection_category=?, triaged_severity=?, triaged_at=?
       WHERE review_id=? AND ordinal=?`,
    )
    .run(
      disposition,
      disposition === 'rejected' ? rejectionCategory!.trim() : null,
      severity ?? null,
      nowIso(),
      reviewId,
      ordinal,
    )
  if (result.changes !== 1) throw new Error(`review ${reviewId} has no finding ${ordinal}`)
}

export function completeReview(reviewId: number, database: Database = writableDb()): void {
  const row = database
    .query(
      `SELECT COUNT(*) AS findings,
            SUM(CASE WHEN disposition IS NULL THEN 1 ELSE 0 END) AS untriaged
       FROM review_finding WHERE review_id=?`,
    )
    .get(reviewId) as { findings: number; untriaged: number | null }
  const review = database.query('SELECT id FROM review WHERE id=?').get(reviewId)
  if (!review) throw new Error(`no review ${reviewId}`)
  if ((row.untriaged ?? 0) > 0)
    throw new Error(`review ${reviewId} still has ${row.untriaged} untriaged findings`)
  database.query('UPDATE review SET completed_at=? WHERE id=?').run(nowIso(), reviewId)
}
