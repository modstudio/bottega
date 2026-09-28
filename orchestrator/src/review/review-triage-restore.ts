// concern: review-triage-restore
/** Restores completed-review finding triage from its latest structured outbox source. */
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import { DB_PATH, writableDb, writeTransaction } from '../database/db.ts'
import { amendFinding, DISPOSITIONS, type Disposition } from './review-triage.ts'
import {
  decideTriageRestore,
  type TriageRestoreDecision,
  type TriageRestoreFinding,
  type TriageRestoreSource,
} from './review-triage-restore-policy.ts'

type OutboxRow = { id: number; record_id: string; payload: string }
type Candidate = TriageRestoreFinding & { reviewId: number }
type SourceLookup = {
  row: OutboxRow | null
  source: TriageRestoreSource | null
  status: 'missing' | 'invalid' | 'valid'
}
type TriageRestoreResult = {
  findingId: number
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
  localId: z.number().int().positive(),
  ordinal: z.number().int().nonnegative(),
  severity: z.string().min(1),
  location: z.string(),
  evidence: z.string(),
  proposedCorrection: z.string(),
  disposition: z.enum(DISPOSITIONS).nullable(),
  rejectionCategory: z.string().nullable().optional(),
  triagedSeverity: z.string().nullable().optional(),
  triagedAt: z.string().nullable().optional(),
})

function candidate(database: Database, findingId: number): Candidate | null {
  return database
    .query<Candidate, [number]>(
      `SELECT finding.id, finding.review_id AS reviewId,
              review.record_id AS reviewRecordId, finding.ordinal, finding.severity,
              finding.location, finding.evidence, finding.record_id AS recordId,
              review.completed_at AS completedAt
         FROM review_finding finding JOIN review ON review.id=finding.review_id
        WHERE finding.id=? AND finding.disposition IS NULL`,
    )
    .get(findingId)
}

function candidateIds(database: Database): number[] {
  return database
    .query<{ id: number }, []>(
      'SELECT id FROM review_finding WHERE disposition IS NULL ORDER BY id',
    )
    .all()
    .map((row) => row.id)
}

function localId(payload: string): number | null {
  try {
    const value: unknown = JSON.parse(payload)
    if (typeof value !== 'object' || value === null) return null
    const id = Reflect.get(value, 'localId')
    return Number.isInteger(id) && Number(id) > 0 ? Number(id) : null
  } catch {
    return null
  }
}

function latestSource(database: Database, findingId: number): SourceLookup {
  const rows = database
    .query<OutboxRow, []>(
      "SELECT id, record_id, payload FROM outbox WHERE kind='review_finding' ORDER BY id DESC",
    )
    .all()
  const row = rows.find((item) => localId(item.payload) === findingId) ?? null
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
      localId: parsed.data.localId,
      ordinal: parsed.data.ordinal,
      severity: parsed.data.severity,
      location: parsed.data.location,
      evidence: parsed.data.evidence,
      disposition: parsed.data.disposition,
      rejectionCategory: parsed.data.rejectionCategory ?? null,
      triagedSeverity: parsed.data.triagedSeverity ?? null,
      triagedAt: parsed.data.triagedAt ?? null,
    },
  }
}

function recordIdReferenced(database: Database, recordId: string | null): boolean {
  if (!recordId) return false
  return Boolean(
    database
      .query<{ present: number }, [string]>(
        'SELECT EXISTS(SELECT 1 FROM outbox WHERE record_id=?) AS present',
      )
      .get(recordId)?.present,
  )
}

function assess(
  database: Database,
  findingId: number,
): {
  finding: Candidate
  decision: TriageRestoreDecision
  outboxId: number | null
} | null {
  const finding = candidate(database, findingId)
  if (!finding) return null
  const lookup = latestSource(database, findingId)
  const decision = decideTriageRestore({
    finding,
    source: lookup.source,
    sourceStatus: lookup.status,
    liveRecordIdReferenced: recordIdReferenced(database, finding.recordId),
  })
  return { finding, decision, outboxId: lookup.row?.id ?? null }
}

function applyOne(
  database: Database,
  findingId: number,
  dryRun: boolean,
): TriageRestoreResult | null {
  const operation = () => {
    const assessed = assess(database, findingId)
    if (!assessed) return null
    const { finding, decision, outboxId } = assessed
    if (decision.action === 'skip') {
      return { findingId, outboxId, action: 'skip', reason: decision.reason } as const
    }
    const source = decision.source
    if (!dryRun) {
      if (decision.restoreRecordId) {
        database
          .query('UPDATE review_finding SET record_id=? WHERE id=?')
          .run(source.recordId, findingId)
      }
      amendFinding(
        finding.reviewId,
        finding.ordinal,
        source.disposition!,
        `restored from outbox row ${source.outboxId}`,
        source.rejectionCategory ?? undefined,
        source.triagedSeverity ?? undefined,
        database,
        source.triagedAt ?? undefined,
      )
    }
    return {
      findingId,
      outboxId: source.outboxId,
      action: 'apply',
      disposition: source.disposition!,
    } as const
  }
  return dryRun ? operation() : writeTransaction(operation, database)
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
  options: { dryRun: boolean },
): TriageRestoreReport {
  const results = candidateIds(database)
    .map((findingId) => applyOne(database, findingId, options.dryRun))
    .filter((result): result is TriageRestoreResult => result !== null)
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
    lines.push(`finding ${row.findingId}: ${row.reason}`)
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
