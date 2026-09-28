// concern: review-triage
import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import type { ReviewReply } from '../contract/contract.ts'
import { nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { parseReviewOutput, recordReviews } from './review.ts'
import { enqueueReview, enqueueReviewFinding, enqueueReviewLens } from './review-outbox.ts'
import {
  REVIEW_SEVERITY,
  type ReviewCoverage,
  type ReviewLimits,
  type ReviewOverlap,
  type ReviewReproduced,
  type ReviewSeverity,
} from './review-vocabulary.ts'

/**
 * Initial safety floor. Re-set this from the observed triage distribution once
 * this repository has enough review data; until then the conservative value
 * prevents a handful of findings from changing reviewer behavior.
 */
export const MIN_REVIEW_TRIAGED = 10

export const DISPOSITIONS = ['accepted', 'modified', 'rejected', 'skipped'] as const
export type Disposition = (typeof DISPOSITIONS)[number]

export function triageValues(
  disposition: Disposition,
  rejectionCategory?: string,
  triagedSeverity?: string,
): { rejectionCategory: string | null; triagedSeverity: string | null } {
  if (!DISPOSITIONS.includes(disposition)) throw new Error(`invalid disposition: ${disposition}`)
  if (disposition === 'rejected' && !rejectionCategory?.trim()) {
    throw new Error('a rejected finding requires --category')
  }
  if (rejectionCategory && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(rejectionCategory)) {
    throw new Error('rejection category must be a lowercase stable id of at most 64 characters')
  }
  const severity = triagedSeverity?.trim()
  if (severity && !REVIEW_SEVERITY.includes(severity as ReviewSeverity)) {
    throw new Error(`severity must be: ${REVIEW_SEVERITY.join(' | ')}`)
  }
  return {
    rejectionCategory: disposition === 'rejected' ? rejectionCategory!.trim() : null,
    triagedSeverity: severity ?? null,
  }
}

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

function assertLensFindingIntegrity(row: {
  review_id: number
  run_id: number
  output_path: string | null
  findings: number
}): void {
  if (!row.output_path || !existsSync(row.output_path)) return
  const output = parseReviewOutput(readFileSync(row.output_path, 'utf8'))
  if (!output || output.findings.length === row.findings) return
  throw new Error(
    `review finding integrity error for run ${row.run_id}: persisted reply has ` +
      `${output.findings.length} findings but stored rows have ${row.findings}; ` +
      `restore the missing review_finding rows before judging, scoring, or completing review ${row.review_id}`,
  )
}

function assertReviewFindingIntegrity(
  scope: { column: 'run_id' | 'review_id'; id: number },
  database: Database,
): void {
  const rows = database
    .query(
      `SELECT rl.review_id, rl.run_id, run.output_path, COUNT(rf.id) AS findings
         FROM review_lens rl JOIN run ON run.id=rl.run_id
         LEFT JOIN review_finding rf ON rf.review_lens_id=rl.id
        WHERE rl.${scope.column}=? GROUP BY rl.id ORDER BY rl.id`,
    )
    .all(scope.id) as {
    review_id: number
    run_id: number
    output_path: string | null
    findings: number
  }[]
  for (const row of rows) assertLensFindingIntegrity(row)
}

export function assertRunReviewFindingIntegrity(
  runId: number,
  database: Database = writableDb(),
): void {
  assertReviewFindingIntegrity({ column: 'run_id', id: runId }, database)
}

function atomic<T>(database: Database, operation: () => T): T {
  return database.inTransaction ? operation() : writeTransaction(operation, database)
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
  atomic(database, () => {
    database
      .query(`UPDATE review_lens SET reproduced=?, coverage=?, limits=?, overlap=? WHERE id=?`)
      .run(grades.reproduced, grades.coverage, grades.limits, grades.overlap, row.id)
    enqueueReviewLens(database, row.id)
  })
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
  const values = triageValues(disposition, rejectionCategory, triagedSeverity)
  const review = database.query('SELECT completed_at FROM review WHERE id=?').get(reviewId) as {
    completed_at: string | null
  } | null
  if (!review) throw new Error(`no review ${reviewId}`)
  if (review.completed_at) {
    throw new Error(
      `review ${reviewId} is already complete; use orch review amend ${reviewId} ${ordinal} ... --reason "<text>"`,
    )
  }
  const finding = database
    .query('SELECT severity FROM review_finding WHERE review_id=? AND ordinal=?')
    .get(reviewId, ordinal) as { severity: string } | null
  if (!finding) throw new Error(`review ${reviewId} has no finding ${ordinal}`)
  atomic(database, () => {
    const result = database
      .query(
        `UPDATE review_finding SET disposition=?, rejection_category=?, triaged_severity=?, triaged_at=?
         WHERE review_id=? AND ordinal=?`,
      )
      .run(
        disposition,
        values.rejectionCategory,
        values.triagedSeverity,
        nowIso(),
        reviewId,
        ordinal,
      )
    if (result.changes !== 1) throw new Error(`review ${reviewId} has no finding ${ordinal}`)
    const updated = database
      .query<{ id: number }, [number, number]>(
        'SELECT id FROM review_finding WHERE review_id=? AND ordinal=?',
      )
      .get(reviewId, ordinal)!
    enqueueReviewFinding(database, updated.id)
  })
}

export function amendFinding(
  reviewId: number,
  ordinal: number,
  disposition: Disposition,
  reason: string,
  rejectionCategory?: string,
  triagedSeverity?: string,
  database: Database = writableDb(),
  triagedAt?: string,
): void {
  const values = triageValues(disposition, rejectionCategory, triagedSeverity)
  const amendmentReason = reason.trim()
  if (!amendmentReason) throw new Error('--reason is required and must be non-empty')
  atomic(database, () => {
    const review = database.query('SELECT completed_at FROM review WHERE id=?').get(reviewId) as {
      completed_at: string | null
    } | null
    if (!review) throw new Error(`no review ${reviewId}`)
    if (!review.completed_at) {
      throw new Error(
        `review ${reviewId} is incomplete; use orch review triage ${reviewId} ${ordinal} ...`,
      )
    }
    const finding = database
      .query<
        {
          id: number
          disposition: string | null
          rejection_category: string | null
          triaged_severity: string | null
        },
        [number, number]
      >(
        `SELECT id, disposition, rejection_category, triaged_severity
         FROM review_finding WHERE review_id=? AND ordinal=?`,
      )
      .get(reviewId, ordinal)
    if (!finding) throw new Error(`review ${reviewId} has no finding ${ordinal}`)
    const at = nowIso()
    database
      .query(
        `INSERT INTO review_finding_amendment
         (review_id,finding_ordinal,old_disposition,new_disposition,
          old_rejection_category,new_rejection_category,old_triaged_severity,new_triaged_severity,
          reason,actor_session,at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        reviewId,
        ordinal,
        finding.disposition,
        disposition,
        finding.rejection_category,
        values.rejectionCategory,
        finding.triaged_severity,
        values.triagedSeverity,
        amendmentReason,
        sessionId(),
        at,
      )
    database
      .query(
        `UPDATE review_finding SET disposition=?, rejection_category=?, triaged_severity=?, triaged_at=?
         WHERE id=?`,
      )
      .run(
        disposition,
        values.rejectionCategory,
        values.triagedSeverity,
        triagedAt ?? at,
        finding.id,
      )
    enqueueReviewFinding(database, finding.id)
    enqueueReview(database, reviewId)
  })
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
  assertReviewFindingIntegrity({ column: 'review_id', id: reviewId }, database)
  if ((row.untriaged ?? 0) > 0)
    throw new Error(`review ${reviewId} still has ${row.untriaged} untriaged findings`)
  atomic(database, () => {
    database.query('UPDATE review SET completed_at=? WHERE id=?').run(nowIso(), reviewId)
    enqueueReview(database, reviewId)
  })
}
