// concern: review-finding-restore
/** Adapts review-finding restore policy to the local SQLite store. */
import { Database } from 'bun:sqlite'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { DATABASE_RESOLUTION, DB_PATH, writableDb, writeTransaction } from '../database/db.ts'
import {
  decideFindingRestores,
  type OrderedRestoreFindingDecision,
  type RestoreFindingFacts,
  type RestoreFindingPayload,
  restoreFindingPayloadSchema,
  reviewOrdinalKey,
} from './review-finding-restore-policy.ts'

type OutboxRow = { id: number; payload: string }
type PreparedInsert = {
  id: number
  reviewId: number
  reviewLensId: number
  ordinal: number
  severity: string
  location: string
  evidence: string
  proposedCorrection: string
}
type FindingRestoreReport = {
  target: string
  mode: 'report-only' | 'write'
  payloadsRead: number
  duplicatePayloads: number
  rowsWouldRestore: number
  rowsRestored: number
  rowsAlreadyPresent: number
  unusable: { outboxId: number; localId: number | null; reason: string }[]
  restoredRowsLacking: {
    disposition: number
    rejectionCategory: number
    triagedSeverity: number
    triagedAt: number
    recordId: number
  }
}

type RestoreFindingFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
}

function canonicalStorePath(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path))
  } catch {
    return resolve(path)
  }
}

function sameStore(left: string, right: string): boolean {
  return canonicalStorePath(left) === canonicalStorePath(right)
}

function restoreFacts(database: Database): RestoreFindingFacts {
  const findings = database
    .query<{ id: number; review_id: number; ordinal: number }, []>(
      'SELECT id, review_id, ordinal FROM review_finding',
    )
    .all()
  const reviews = database
    .query<{ id: number; record_id: string }, []>(
      'SELECT id, record_id FROM review WHERE record_id IS NOT NULL',
    )
    .all()
  const lenses = database
    .query<{ id: number; review_id: number; record_id: string }, []>(
      'SELECT id, review_id, record_id FROM review_lens WHERE record_id IS NOT NULL',
    )
    .all()
  return {
    existingFindingIds: new Set(findings.map((row) => row.id)),
    findingIdByReviewOrdinal: new Map(
      findings.map((row) => [reviewOrdinalKey(row.review_id, row.ordinal), row.id]),
    ),
    reviewIdByRecordId: new Map(reviews.map((row) => [row.record_id, row.id])),
    lensByRecordId: new Map(
      lenses.map((row) => [row.record_id, { id: row.id, reviewId: row.review_id }]),
    ),
  }
}

function parsePayload(
  row: OutboxRow,
):
  | { ok: true; payload: RestoreFindingPayload }
  | { ok: false; localId: number | null; reason: string } {
  let value: unknown
  try {
    value = JSON.parse(row.payload)
  } catch {
    return {
      ok: false,
      localId: null,
      reason: `outbox ${row.id} payload is not valid JSON`,
    }
  }
  const parsed = restoreFindingPayloadSchema.safeParse(value)
  if (parsed.success) return { ok: true, payload: parsed.data }
  const localId =
    typeof value === 'object' && value !== null && Number.isInteger(Reflect.get(value, 'localId'))
      ? Number(Reflect.get(value, 'localId'))
      : null
  return {
    ok: false,
    localId,
    reason: `outbox ${row.id} payload is unusable: ${z.prettifyError(parsed.error)}`,
  }
}

function parsePayloads(rows: readonly OutboxRow[]): {
  payloads: { outboxId: number; payload: RestoreFindingPayload }[]
  unusable: FindingRestoreReport['unusable']
} {
  const payloads: { outboxId: number; payload: RestoreFindingPayload }[] = []
  const unusable: FindingRestoreReport['unusable'] = []
  for (const row of rows) {
    const parsed = parsePayload(row)
    if (parsed.ok) payloads.push({ outboxId: row.id, payload: parsed.payload })
    else unusable.push({ outboxId: row.id, localId: parsed.localId, reason: parsed.reason })
  }
  return { payloads, unusable }
}

function prepareInserts(
  decisions: readonly OrderedRestoreFindingDecision[],
  unusable: FindingRestoreReport['unusable'],
): { inserts: PreparedInsert[]; duplicatePayloads: number; rowsAlreadyPresent: number } {
  const inserts: PreparedInsert[] = []
  let duplicatePayloads = 0
  let rowsAlreadyPresent = 0
  for (const decision of decisions) {
    if (decision.action === 'duplicate') duplicatePayloads++
    else if (decision.action === 'skip') rowsAlreadyPresent++
    else if (decision.action === 'refuse') {
      unusable.push({
        outboxId: decision.outboxId,
        localId: decision.payload.localId,
        reason: decision.reason,
      })
    } else {
      inserts.push({
        id: decision.payload.localId,
        reviewId: decision.reviewId,
        reviewLensId: decision.reviewLensId,
        ordinal: decision.payload.ordinal,
        severity: decision.payload.severity,
        location: decision.payload.location,
        evidence: decision.payload.evidence,
        proposedCorrection: decision.payload.proposedCorrection,
      })
    }
  }
  return { inserts, duplicatePayloads, rowsAlreadyPresent }
}

function restoreReviewFindings(
  database: Database,
  target: string,
  write: boolean,
): FindingRestoreReport {
  const rows = database
    .query<OutboxRow, []>("SELECT id, payload FROM outbox WHERE kind='review_finding' ORDER BY id")
    .all()
  const { payloads, unusable } = parsePayloads(rows)
  const decisions = decideFindingRestores(payloads, restoreFacts(database))
  const { inserts, duplicatePayloads, rowsAlreadyPresent } = prepareInserts(decisions, unusable)

  if (write && !unusable.length) {
    const insert = database.query(
      `INSERT INTO review_finding
       (id, review_id, review_lens_id, ordinal, severity, location, evidence, proposed_correction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    writeTransaction(() => {
      for (const row of inserts) {
        insert.run(
          row.id,
          row.reviewId,
          row.reviewLensId,
          row.ordinal,
          row.severity,
          row.location,
          row.evidence,
          row.proposedCorrection,
        )
      }
    }, database)
  }

  const rowsRestored = write && !unusable.length ? inserts.length : 0
  return {
    target,
    mode: write ? 'write' : 'report-only',
    payloadsRead: rows.length,
    duplicatePayloads,
    rowsWouldRestore: unusable.length ? 0 : inserts.length,
    rowsRestored,
    rowsAlreadyPresent,
    unusable,
    restoredRowsLacking: {
      disposition: unusable.length ? 0 : inserts.length,
      rejectionCategory: unusable.length ? 0 : inserts.length,
      triagedSeverity: unusable.length ? 0 : inserts.length,
      triagedAt: unusable.length ? 0 : inserts.length,
      recordId: unusable.length ? 0 : inserts.length,
    },
  }
}

function renderFindingRestoreReport(report: FindingRestoreReport): string {
  const lines = [
    `target: ${report.target}`,
    `mode: ${report.mode}`,
    `payloads read: ${report.payloadsRead}`,
    `duplicate payloads: ${report.duplicatePayloads}`,
    `rows that would be restored: ${report.rowsWouldRestore}`,
    `rows restored: ${report.rowsRestored}`,
    `rows already present: ${report.rowsAlreadyPresent}`,
    `payloads unusable: ${report.unusable.length}`,
  ]
  for (const item of report.unusable) lines.push(`outbox ${item.outboxId}: ${item.reason}`)
  for (const [field, count] of Object.entries(report.restoredRowsLacking)) {
    lines.push(`restored rows lacking ${field}: ${count}`)
  }
  return lines.join('\n')
}

export function restoreReviewFindingsCommand(
  flags: RestoreFindingFlags,
  presentation: { log(value: string): void },
): void {
  const write = flags.has('write')
  const target = DB_PATH
  if (write && !flags.has('confirm-restore')) {
    throw new Error(
      `refusing to write review findings to ${target}: --write also requires --confirm-restore`,
    )
  }
  if (write && sameStore(target, DATABASE_RESOLUTION.mainStorePath)) {
    const namedTarget = flags.flag('confirm-live-store')
    if (!namedTarget || !sameStore(namedTarget, target)) {
      throw new Error(
        `refusing to write the registered live store ${target}: ` +
          `repeat with --write --confirm-restore --confirm-live-store ${JSON.stringify(target)}`,
      )
    }
  }

  let database: Database
  let close = false
  if (write) {
    try {
      database = writableDb()
    } catch (error) {
      throw new Error(
        `cannot open review finding restore target ${target} for writing: ${String(error)}`,
      )
    }
  } else {
    database = new Database(target, { readonly: true })
    database.exec('PRAGMA foreign_keys = ON')
    close = true
  }
  try {
    const report = restoreReviewFindings(database, target, write)
    presentation.log(
      flags.has('json') ? JSON.stringify(report) : renderFindingRestoreReport(report),
    )
    if (report.unusable.length) {
      throw new Error(
        `refusing to restore review findings in ${target}: ${report.unusable.length} payload(s) could not be used`,
      )
    }
  } finally {
    if (close) database.close()
  }
}
