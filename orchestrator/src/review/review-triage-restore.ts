// concern: review-triage-restore
/** Restores completed-review finding triage from its latest structured outbox source. */
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import { DB_PATH, writableDb, writeTransaction } from '../database/db.ts'
import { amendFinding, triageValues } from './review-triage.ts'
import {
  decideTriageRestore,
  matchesTriageRestoreIdentity,
  TRIAGE_RESTORE_SKIP_REASONS,
  type TriageRestoreDecision,
  type TriageRestoreFinding,
  type TriageRestoreSource,
} from './review-triage-restore-policy.ts'
import { DISPOSITIONS, type Disposition } from './review-vocabulary.ts'

type OutboxRow = { id: number; row_id: string; payload: string }
type Candidate = TriageRestoreFinding
type ReviewFinding = Candidate & { disposition: string | null }
type SourceLookup = {
  row: OutboxRow | null
  source: TriageRestoreSource | null
  status: 'missing' | 'invalid' | 'valid'
}
type TriageRestoreResult = {
  finding: string
  outboxId: number | null
  action: 'apply' | 'skip'
  disposition?: Disposition
  reason?: string
}
export type TriageRestoreReport = {
  mode: 'apply' | 'dry-run'
  applied: number
  byDisposition: Record<Disposition, number>
  skipped: number
  byReason: Record<string, number>
  rows: TriageRestoreResult[]
}

type TriageRestoreFlags = { has(name: string): boolean }
type TriageRestorePresentation = { log(value: string): void }

const sourcePayloadSchema = z.object({
  id: z.string().min(1),
  reviewId: z.string().min(1),
  reviewLensId: z.string().min(1),
  localId: z.null(),
  ordinal: z.number().int().nonnegative(),
  severity: z.string().min(1),
  location: z.string(),
  evidence: z.string(),
  proposedCorrection: z.string(),
  disposition: z.enum(DISPOSITIONS).nullable(),
  rejectionCategory: z.string().nullable().optional(),
  triagedSeverity: z.string().nullable().optional(),
  triagedAt: z.string().nullable().optional(),
  withheldFields: z.array(z.string()).nullable().optional(),
})

function candidate(database: Database, findingRecordId: string): Candidate | null {
  return database
    .query<Candidate, [string]>(
      `SELECT finding.review_record_id AS reviewRecordId, finding.ordinal, finding.severity,
              finding.location, finding.evidence, finding.record_id AS recordId,
              review.number || '/' || finding.ordinal AS displayHandle,
              review.completed_at AS completedAt
         FROM review_finding finding JOIN review ON review.record_id=finding.review_record_id
        WHERE finding.record_id=? AND finding.disposition IS NULL`,
    )
    .get(findingRecordId)
}

function openCandidateIds(database: Database): string[] {
  return database
    .query<{ record_id: string }, []>(
      `SELECT finding.record_id FROM review_finding finding
         JOIN review ON review.record_id=finding.review_record_id
        WHERE finding.disposition IS NULL AND review.completed_at IS NULL
        ORDER BY review.number,finding.ordinal`,
    )
    .all()
    .map((row) => row.record_id)
}

function completedReviewIds(database: Database): string[] {
  return database
    .query<{ record_id: string }, []>(
      `SELECT DISTINCT review.record_id
         FROM review JOIN review_finding finding ON finding.review_record_id=review.record_id
        WHERE finding.disposition IS NULL AND review.completed_at IS NOT NULL
        ORDER BY review.number`,
    )
    .all()
    .map((row) => row.record_id)
}

function reviewFindings(database: Database, reviewRecordId: string): ReviewFinding[] {
  return database
    .query<ReviewFinding, [string]>(
      `SELECT finding.review_record_id AS reviewRecordId, finding.ordinal, finding.severity,
              finding.location, finding.evidence, finding.record_id AS recordId,
              review.number || '/' || finding.ordinal AS displayHandle,
              finding.disposition, review.completed_at AS completedAt
         FROM review_finding finding JOIN review ON review.record_id=finding.review_record_id
        WHERE finding.review_record_id=? ORDER BY finding.ordinal`,
    )
    .all(reviewRecordId)
}

function latestSource(
  database: Database,
  finding: Pick<Candidate, 'reviewRecordId' | 'ordinal'>,
): SourceLookup {
  const row = database
    .query<OutboxRow, [string, number]>(
      `SELECT id, row_id, payload FROM outbox
        WHERE kind='review_finding' AND json_valid(payload)
          AND json_extract(payload,'$.reviewId')=?
          AND json_extract(payload,'$.ordinal')=?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(finding.reviewRecordId, finding.ordinal)
  if (!row) return { row: null, source: null, status: 'missing' }
  let value: unknown
  try {
    value = JSON.parse(row.payload)
  } catch {
    return { row, source: null, status: 'invalid' }
  }
  const parsed = sourcePayloadSchema.safeParse(value)
  if (!parsed.success) return { row, source: null, status: 'invalid' }
  return {
    row,
    status: 'valid',
    source: {
      outboxId: row.id,
      recordId: parsed.data.id,
      reviewRecordId: parsed.data.reviewId,
      ordinal: parsed.data.ordinal,
      severity: parsed.data.severity,
      location: parsed.data.location,
      evidence: parsed.data.evidence,
      disposition: parsed.data.disposition,
      rejectionCategory: parsed.data.rejectionCategory ?? null,
      triagedSeverity: parsed.data.triagedSeverity ?? null,
      triagedAt: parsed.data.triagedAt ?? null,
      withheldFields: parsed.data.withheldFields ?? [],
    },
  }
}

function recordIdReferenced(database: Database, recordId: string): boolean {
  return Boolean(
    database
      .query<{ present: number }, [string]>(
        'SELECT EXISTS(SELECT 1 FROM outbox WHERE row_id=?) AS present',
      )
      .get(recordId)?.present,
  )
}

function assess(
  database: Database,
  findingRecordId: string,
): {
  finding: Candidate
  decision: TriageRestoreDecision
  outboxId: number | null
} | null {
  const finding = candidate(database, findingRecordId)
  if (!finding) return null
  const lookup = latestSource(database, finding)
  const decision = decideTriageRestore({
    finding,
    source: lookup.source,
    sourceStatus: lookup.status,
    liveRecordIdReferenced: recordIdReferenced(database, finding.recordId),
  })
  return { finding, decision, outboxId: lookup.row?.id ?? null }
}

type ReviewSnapshot = {
  reviewRecordId: string
  findings: Array<{ finding: ReviewFinding; lookup: SourceLookup; recordIdReferenced: boolean }>
  candidates: Array<NonNullable<ReturnType<typeof assess>>>
}

function invalidTriageReason(source: TriageRestoreSource): string | null {
  try {
    triageValues(
      source.disposition!,
      source.rejectionCategory ?? undefined,
      source.triagedSeverity ?? undefined,
    )
    return null
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return (
      `source triage refused: disposition=${source.disposition}, ` +
      `rejectionCategory=${JSON.stringify(source.rejectionCategory)}, ` +
      `triagedSeverity=${JSON.stringify(source.triagedSeverity)}: ${detail}`
    )
  }
}

function snapshotReview(database: Database, reviewRecordId: string): ReviewSnapshot {
  const findings = reviewFindings(database, reviewRecordId).map((finding) => ({
    finding,
    lookup: latestSource(database, finding),
    recordIdReferenced: recordIdReferenced(database, finding.recordId),
  }))
  const candidates = findings
    .filter(({ finding }) => finding.disposition === null)
    .map(({ finding, lookup, recordIdReferenced: referenced }) => ({
      finding,
      decision: (() => {
        const decision = decideTriageRestore({
          finding,
          source: lookup.source,
          sourceStatus: lookup.status,
          liveRecordIdReferenced: referenced,
        })
        if (decision.action === 'skip') return decision
        const reason = invalidTriageReason(decision.source)
        return reason === null ? decision : ({ action: 'skip', reason } as const)
      })(),
      outboxId: lookup.row?.id ?? null,
    }))
  return { reviewRecordId, findings, candidates }
}

function restoreReview(
  database: Database,
  reviewRecordId: string,
  dryRun: boolean,
): TriageRestoreResult[] {
  const run = (): TriageRestoreResult[] => {
    const snapshot = snapshotReview(database, reviewRecordId)
    const restorations = snapshot.findings.filter(({ finding, lookup, recordIdReferenced }) => {
      const source = lookup.source
      return (
        source !== null &&
        matchesTriageRestoreIdentity(finding, source) &&
        finding.recordId !== source.recordId &&
        !recordIdReferenced
      )
    })

    const results = snapshot.candidates.map(({ finding, decision, outboxId }) =>
      decision.action === 'skip'
        ? ({
            finding: finding.displayHandle,
            outboxId,
            action: 'skip',
            reason: decision.reason,
          } as const)
        : ({
            finding: finding.displayHandle,
            outboxId: decision.source.outboxId,
            action: 'apply',
            disposition: decision.source.disposition!,
          } as const),
    )
    if (dryRun) return results

    for (const { finding, lookup } of restorations) {
      database
        .query('UPDATE review_finding SET record_id=? WHERE record_id=?')
        .run(lookup.source!.recordId, finding.recordId)
    }
    for (const { finding, decision } of snapshot.candidates) {
      if (decision.action === 'apply') {
        const source = decision.source
        amendFinding(
          finding.reviewRecordId,
          finding.ordinal,
          source.disposition!,
          `restored from outbox row ${source.outboxId}`,
          source.rejectionCategory ?? undefined,
          source.triagedSeverity ?? undefined,
          database,
          source.triagedAt ?? undefined,
        )
      }
    }
    return results
  }
  return dryRun ? run() : writeTransaction(run, database)
}

function reportFor(results: TriageRestoreResult[], dryRun: boolean): TriageRestoreReport {
  const byDisposition = Object.fromEntries(DISPOSITIONS.map((value) => [value, 0])) as Record<
    Disposition,
    number
  >
  const byReason: Record<string, number> = {}
  for (const result of results) {
    if (result.action === 'apply') byDisposition[result.disposition!]++
    else byReason[result.reason!] = (byReason[result.reason!] ?? 0) + 1
  }
  return {
    mode: dryRun ? 'dry-run' : 'apply',
    applied: results.filter((result) => result.action === 'apply').length,
    byDisposition,
    skipped: results.filter((result) => result.action === 'skip').length,
    byReason,
    rows: results,
  }
}

export function restoreReviewTriage(
  database: Database,
  options: { dryRun: boolean; beforeReview?: (reviewRecordId: string) => void },
): TriageRestoreReport {
  const openResults: TriageRestoreResult[] = []
  for (const findingRecordId of openCandidateIds(database)) {
    const assessed = assess(database, findingRecordId)
    if (!assessed) continue
    openResults.push({
      finding: assessed.finding.displayHandle,
      outboxId: assessed.outboxId,
      action: 'skip',
      reason: TRIAGE_RESTORE_SKIP_REASONS.openReview,
    })
  }
  const reviewRecordIds = completedReviewIds(database)
  const results = [
    ...openResults,
    ...reviewRecordIds.flatMap((reviewRecordId) => {
      options.beforeReview?.(reviewRecordId)
      return restoreReview(database, reviewRecordId, options.dryRun)
    }),
  ].sort((a, b) => a.finding.localeCompare(b.finding, undefined, { numeric: true }))
  return reportFor(results, options.dryRun)
}

function renderReport(report: TriageRestoreReport): string {
  const verb = report.mode === 'dry-run' ? 'would apply' : 'applied'
  const lines = [
    `mode: ${report.mode}`,
    `${verb}: ${report.applied}`,
    ...DISPOSITIONS.map((value) => `  ${value}: ${report.byDisposition[value]}`),
    `skipped: ${report.skipped}`,
    ...Object.entries(report.byReason).map(([reason, count]) => `  ${reason}: ${count}`),
  ]
  for (const row of report.rows.filter((item) => item.action === 'skip')) {
    lines.push(`finding ${row.finding}: ${row.reason}`)
  }
  return lines.join('\n')
}

export function restoreReviewTriageCommand(
  flags: TriageRestoreFlags,
  presentation: TriageRestorePresentation,
): void {
  const dryRun = flags.has('dry-run')
  const database = dryRun ? new Database(DB_PATH, { readonly: true }) : writableDb()
  const close = dryRun
  if (dryRun) database.exec('PRAGMA foreign_keys = ON')
  try {
    const report = restoreReviewTriage(database, { dryRun })
    presentation.log(flags.has('json') ? JSON.stringify(report) : renderReport(report))
  } finally {
    if (close) database.close()
  }
}
