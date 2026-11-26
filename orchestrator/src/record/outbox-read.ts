// concern: outbox-read
/** Owns reads and size-only inspection of locally stored hosted-record writes. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'

// SQLite documents unary + to prevent terms driving index choice; outbox_synced_at is selective.
export const PENDING_OUTBOX_PREDICATE_SQL =
  'synced_at IS NULL AND +quarantined_at IS NULL AND +retired_at IS NULL'

/** Matches migration 0234's partial index predicate exactly. */
export const QUARANTINED_UNRETIRED_OUTBOX_PREDICATE_SQL =
  'quarantined_at IS NOT NULL AND retired_at IS NULL'

export type OutboxPayloadField = {
  name: string
  type: string
  bytes: number
  children?: OutboxPayloadField[] | OutboxArraySummary
}

export type OutboxArraySummary = {
  count: number
  bytes: number
  largestIndex: number | null
  largestBytes: number | null
}

export type OutboxRowReport = {
  id: string
  kind: string
  rowId: string
  recordId: string
  state: 'queued' | 'quarantined' | 'sent' | 'retired'
  attempts: number
  quarantinedAt: string | null
  reason: string | null
  payloadBytes: number
  fields: OutboxPayloadField[] | null
  parseError?: string
}

type StoredOutboxRow = {
  id: number
  kind: string
  row_id: string
  record_id: string
  payload: string
  attempts: number
  synced_at: string | null
  quarantined_at: string | null
  quarantine_reason: string | null
  retired_at: string | null
}

type OutboxPayloadRecord = Pick<StoredOutboxRow, 'kind' | 'row_id' | 'payload'>

export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength

function sourceProjectRecordId(
  database: Database,
  row: OutboxPayloadRecord,
): string | null | undefined {
  const queries: Partial<Record<string, string>> = {
    run: `SELECT project.record_id FROM run
      LEFT JOIN project ON project.record_id=run.project_record_id WHERE run.record_id=?`,
    score: `SELECT project.record_id FROM run
      LEFT JOIN project ON project.record_id=run.project_record_id WHERE run.record_id=?`,
    review: `SELECT project.record_id FROM review
      LEFT JOIN project ON project.record_id=review.project_record_id WHERE review.record_id=?`,
    review_lens: `SELECT project.record_id FROM review_lens
      JOIN review ON review.record_id=review_lens.review_record_id
      LEFT JOIN project ON project.record_id=review.project_record_id WHERE review_lens.record_id=?`,
    review_finding: `SELECT project.record_id FROM review_finding
      JOIN review ON review.record_id=review_finding.review_record_id
      LEFT JOIN project ON project.record_id=review.project_record_id WHERE review_finding.record_id=?`,
    review_read: `SELECT project.record_id FROM review_read
      LEFT JOIN project ON project.record_id=review_read.project_record_id WHERE review_read.record_id=?`,
    review_funnel_decision: `SELECT project.record_id FROM review_funnel_decision
      LEFT JOIN project ON project.record_id=review_funnel_decision.project_record_id WHERE review_funnel_decision.record_id=?`,
    landing: `SELECT project.record_id FROM landing
      LEFT JOIN project ON project.record_id=landing.project_record_id WHERE landing.record_id=?`,
    landing_override: `SELECT project.record_id FROM landing_override
      LEFT JOIN project ON project.record_id=landing_override.project_record_id
      WHERE landing_override.record_id=?`,
    landing_review_carry: `SELECT project.record_id FROM landing_review_carry
      LEFT JOIN project ON project.record_id=landing_review_carry.project_record_id
      WHERE landing_review_carry.record_id=?`,
    landing_triage_snapshot: `SELECT project.record_id FROM landing_triage_snapshot
      LEFT JOIN project ON project.record_id=landing_triage_snapshot.project_record_id
      WHERE landing_triage_snapshot.record_id=?`,
    release: `SELECT project.record_id FROM release_ledger
      LEFT JOIN project ON project.record_id=release_ledger.project_record_id WHERE release_ledger.record_id=?`,
  }
  const query = queries[row.kind]
  if (!query) return undefined
  return database.query<{ record_id: string | null }, [string]>(query).get(row.row_id)?.record_id ?? null
}

/** Returns the exact payload string whose UTF-8 size the sync limit checks. */
export function outboxPayloadForRecordSync(
  database: Database,
  row: OutboxPayloadRecord,
  parsed: Record<string, unknown> | null,
): string {
  if (!parsed || parsed.projectId != null || parsed.projectName == null) return row.payload
  const projectId = sourceProjectRecordId(database, row)
  if (projectId === undefined) return row.payload
  return JSON.stringify({
    ...parsed,
    projectId,
    ...(projectId ? {} : { projectName: null }),
  })
}

function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function valueBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value))
}

function sortedFields(value: Record<string, unknown>): OutboxPayloadField[] {
  return Object.entries(value)
    .map(([name, child]) => ({ name, type: jsonType(child), bytes: valueBytes(child) }))
    .toSorted((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))
}

function arraySummary(value: unknown[], bytes: number): OutboxArraySummary {
  let largestIndex: number | null = null
  let largestBytes: number | null = null
  for (const [index, child] of value.entries()) {
    const bytes = valueBytes(child)
    if (largestBytes === null || bytes > largestBytes) {
      largestIndex = index
      largestBytes = bytes
    }
  }
  return { count: value.length, bytes, largestIndex, largestBytes }
}

/** Measures parsed values without retaining or returning any payload value. */
export function measureOutboxPayload(
  payload: Record<string, unknown>,
  payloadBytes: number,
): OutboxPayloadField[] {
  return Object.entries(payload)
    .map(([name, value]) => {
      const bytes = valueBytes(value)
      const field: OutboxPayloadField = { name, type: jsonType(value), bytes }
      if (bytes * 10 >= payloadBytes) {
        if (Array.isArray(value)) field.children = arraySummary(value, bytes)
        else if (typeof value === 'object' && value !== null)
          field.children = sortedFields(value as Record<string, unknown>)
      }
      return field
    })
    .toSorted((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))
}

function state(row: StoredOutboxRow): OutboxRowReport['state'] {
  if (row.retired_at) return 'retired'
  if (row.quarantined_at) return 'quarantined'
  if (row.synced_at) return 'sent'
  return 'queued'
}

function safeParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Bun quotes unexpected source identifiers. Remove those source fragments while retaining
  // the parser's diagnosis and punctuation-oriented expectations.
  return message.replace(/"[^"]*"/g, '"[text omitted]"')
}

export function readOutboxRowReport(
  rowId: number,
  database: Database = db(),
): OutboxRowReport {
  const row = database
    .query<StoredOutboxRow, [number]>(
      `SELECT id,kind,row_id,record_id,payload,attempts,synced_at,quarantined_at,
              quarantine_reason,retired_at
         FROM outbox WHERE id=?`,
    )
    .get(rowId)
  if (!row) {
    throw new Error(
      `orchestrator outbox row ${rowId} does not exist; run \`${PLATFORM_SLUG} record outbox\` to list existing rows`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(row.payload)
  } catch (error) {
    const payloadBytes = utf8Bytes(row.payload)
    return {
      id: `orch:${row.id}`,
      kind: row.kind,
      rowId: row.row_id,
      recordId: row.record_id,
      state: state(row),
      attempts: row.attempts,
      quarantinedAt: row.quarantined_at,
      reason: row.quarantine_reason,
      payloadBytes,
      fields: null,
      parseError: safeParseError(error),
    }
  }
  const parsedObject =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : ({} as Record<string, unknown>)
  const payload = outboxPayloadForRecordSync(database, row, parsedObject)
  const payloadBytes = utf8Bytes(payload)
  const base = {
    id: `orch:${row.id}`,
    kind: row.kind,
    rowId: row.row_id,
    recordId: row.record_id,
    state: state(row),
    attempts: row.attempts,
    quarantinedAt: row.quarantined_at,
    reason: row.quarantine_reason,
    payloadBytes,
  }
  return { ...base, fields: measureOutboxPayload(JSON.parse(payload), payloadBytes) }
}
