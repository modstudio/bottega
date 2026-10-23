// concern: review-triage
import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import type { ReviewReply } from '../contract/contract.ts'
import { nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { parseReviewOutput, recordReviews } from './review.ts'
import { enqueueReview, enqueueReviewFinding, enqueueReviewLens } from './review-outbox.ts'
import {
  DISPOSITIONS,
  type Disposition,
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
  review_number: number
  run_record_id: string
  output_path: string | null
  findings: number
}): void {
  if (!row.output_path || !existsSync(row.output_path)) return
  const output = parseReviewOutput(readFileSync(row.output_path, 'utf8'))
  if (!output || output.findings.length === row.findings) return
  throw new Error(
    `review finding integrity error for run ${row.run_record_id}: persisted reply has ` +
      `${output.findings.length} findings but stored rows have ${row.findings}; ` +
      `restore the missing review_finding rows before judging, scoring, or completing review ${row.review_number}`,
  )
}

function assertReviewFindingIntegrity(
  scope: { column: 'run_record_id' | 'review_record_id'; id: string },
  database: Database,
): void {
  const rows = database
    .query(
      `SELECT review.number AS review_number, rl.run_record_id, run.output_path, COUNT(rf.record_id) AS findings
         FROM review_lens rl JOIN run ON run.record_id=rl.run_record_id
         JOIN review ON review.record_id=rl.review_record_id
         LEFT JOIN review_finding rf ON rf.review_lens_record_id=rl.record_id
        WHERE rl.${scope.column}=? GROUP BY rl.record_id ORDER BY run.started_at,rl.record_id`,
    )
    .all(scope.id) as {
    review_number: number
    run_record_id: string
    output_path: string | null
    findings: number
  }[]
  for (const row of rows) assertLensFindingIntegrity(row)
}

export function assertRunReviewFindingIntegrity(
  runId: string,
  database: Database = writableDb(),
): void {
  assertReviewFindingIntegrity({ column: 'run_record_id', id: runId }, database)
}

function atomic<T>(database: Database, operation: () => T): T {
  return database.inTransaction ? operation() : writeTransaction(operation, database)
}

export function recordReview(runId: string, output: ReviewReply, database: Database): string {
  return recordReviews([{ runId, output }], database)
}

export function gradeReviewLens(
  runId: string,
  output: ReviewReply | null,
  grades: ReviewGrades,
  database: Database = writableDb(),
): string {
  let row = database
    .query('SELECT record_id, review_record_id FROM review_lens WHERE run_record_id=?')
    .get(runId) as {
    record_id: string
    review_record_id: string
  } | null
  if (!row) {
    if (!output) throw new Error(`run ${runId} has no review output to record`)
    // The scoring path records through recordReview so it shares the same
    // best-effort commit pinning as `bottega review record`.
    const reviewRecordId = recordReview(runId, output, database)
    row = database
      .query('SELECT record_id, review_record_id FROM review_lens WHERE run_record_id=?')
      .get(runId) as {
      record_id: string
      review_record_id: string
    }
    if (row.review_record_id !== reviewRecordId)
      throw new Error(`run ${runId} review capture did not persist`)
  }
  atomic(database, () => {
    database
      .query(
        `UPDATE review_lens SET reproduced=?, coverage=?, limits=?, overlap=? WHERE record_id=?`,
      )
      .run(grades.reproduced, grades.coverage, grades.limits, grades.overlap, row.record_id)
    enqueueReviewLens(database, row.record_id)
  })
  return row.review_record_id
}

export function triageFinding(
  reviewRecordId: string,
  ordinal: number,
  disposition: Disposition,
  rejectionCategory?: string,
  triagedSeverity?: string,
  database: Database = writableDb(),
): void {
  const values = triageValues(disposition, rejectionCategory, triagedSeverity)
  const review = database
    .query('SELECT number,completed_at FROM review WHERE record_id=?')
    .get(reviewRecordId) as {
    number: number
    completed_at: string | null
  } | null
  if (!review) throw new Error(`no review ${reviewRecordId}`)
  if (review.completed_at) {
    throw new Error(
      `review ${review.number} is already complete; use ${PLATFORM_SLUG} review amend ${review.number} ${ordinal} ... --reason "<text>"`,
    )
  }
  const finding = database
    .query('SELECT severity FROM review_finding WHERE review_record_id=? AND ordinal=?')
    .get(reviewRecordId, ordinal) as { severity: string } | null
  if (!finding) throw new Error(`review ${review.number} has no finding ${ordinal}`)
  atomic(database, () => {
    const result = database
      .query(
        `UPDATE review_finding SET disposition=?, rejection_category=?, triaged_severity=?, triaged_at=?
         WHERE review_record_id=? AND ordinal=?`,
      )
      .run(
        disposition,
        values.rejectionCategory,
        values.triagedSeverity,
        nowIso(),
        reviewRecordId,
        ordinal,
      )
    if (result.changes !== 1) throw new Error(`review ${review.number} has no finding ${ordinal}`)
    const updated = database
      .query<{ record_id: string }, [string, number]>(
        'SELECT record_id FROM review_finding WHERE review_record_id=? AND ordinal=?',
      )
      .get(reviewRecordId, ordinal)!
    enqueueReviewFinding(database, updated.record_id)
  })
}

export function amendFinding(
  reviewRecordId: string,
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
    const review = database
      .query('SELECT number,completed_at FROM review WHERE record_id=?')
      .get(reviewRecordId) as {
      number: number
      completed_at: string | null
    } | null
    if (!review) throw new Error(`no review ${reviewRecordId}`)
    if (!review.completed_at) {
      throw new Error(
        `review ${review.number} is incomplete; use ${PLATFORM_SLUG} review triage ${review.number} ${ordinal} ...`,
      )
    }
    const finding = database
      .query<
        {
          record_id: string
          disposition: string | null
          rejection_category: string | null
          triaged_severity: string | null
        },
        [string, number]
      >(
        `SELECT record_id, disposition, rejection_category, triaged_severity
         FROM review_finding WHERE review_record_id=? AND ordinal=?`,
      )
      .get(reviewRecordId, ordinal)
    if (!finding) throw new Error(`review ${review.number} has no finding ${ordinal}`)
    const at = nowIso()
    database
      .query(
        `INSERT INTO review_finding_amendment
         (record_id,review_finding_record_id,old_disposition,new_disposition,
          old_rejection_category,new_rejection_category,old_triaged_severity,new_triaged_severity,
          reason,actor_session,at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        newRecordId(),
        finding.record_id,
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
         WHERE record_id=?`,
      )
      .run(
        disposition,
        values.rejectionCategory,
        values.triagedSeverity,
        triagedAt ?? at,
        finding.record_id,
      )
    enqueueReviewFinding(database, finding.record_id)
    enqueueReview(database, reviewRecordId)
  })
}

export function completeReview(reviewRecordId: string, database: Database = writableDb()): void {
  const row = database
    .query(
      `SELECT COUNT(*) AS findings,
            SUM(CASE WHEN disposition IS NULL THEN 1 ELSE 0 END) AS untriaged
       FROM review_finding WHERE review_record_id=?`,
    )
    .get(reviewRecordId) as { findings: number; untriaged: number | null }
  const review = database
    .query('SELECT number FROM review WHERE record_id=?')
    .get(reviewRecordId) as { number: number } | null
  if (!review) throw new Error(`no review ${reviewRecordId}`)
  assertReviewFindingIntegrity({ column: 'review_record_id', id: reviewRecordId }, database)
  if ((row.untriaged ?? 0) > 0)
    throw new Error(`review ${review.number} still has ${row.untriaged} untriaged findings`)
  atomic(database, () => {
    database
      .query('UPDATE review SET completed_at=? WHERE record_id=?')
      .run(nowIso(), reviewRecordId)
    enqueueReview(database, reviewRecordId)
  })
}
