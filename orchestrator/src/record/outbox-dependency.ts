// concern: outbox-dependency
/** Resolves local outbox parent state without knowing how hosted rows are sent. */
import type { Database } from 'bun:sqlite'
import type { BlockedOutboxRow, OutboxRow, Payload } from './record-sync-types.ts'

type ParentRef = { kind: string; recordId: string }

type ParentState = {
  synced_at: string | null
  quarantined_at: string | null
  retired_at: string | null
}

const nullableString = (value: unknown): string | null => (value == null ? null : String(value))

function reviewRunIds(database: Database, reviewRecordId: string): string[] {
  const tables = database
    .query<{ count: number }, []>(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='review_lens'",
    )
    .get()!.count
  if (!tables) return []
  return database
    .query<{ record_id: string }, [string]>(
      `SELECT DISTINCT run.record_id FROM review
       JOIN review_lens ON review_lens.review_id=review.id
       JOIN run ON run.id=review_lens.run_id
       WHERE review.record_id=? AND run.record_id IS NOT NULL`,
    )
    .all(reviewRecordId)
    .map((row) => row.record_id)
}

function lensRunId(database: Database, lensRecordId: string): string | null {
  const row = database
    .query<{ payload: string }, [string]>(
      `SELECT payload FROM outbox WHERE kind='review_lens' AND record_id=? ORDER BY id DESC LIMIT 1`,
    )
    .get(lensRecordId)
  if (!row) return null
  return nullableString((JSON.parse(row.payload) as Payload).runId)
}

function outboxParentRecordIds(row: OutboxRow, payload: Payload, database: Database): ParentRef[] {
  switch (row.kind) {
    case 'run':
      return [
        { kind: 'run', recordId: nullableString(payload.parentRunId) },
        { kind: 'run', recordId: nullableString(payload.retryOf) },
      ].filter((value): value is ParentRef => value.recordId !== null)
    case 'score':
      return [{ kind: 'run', recordId: row.record_id }]
    case 'question':
    case 'contention':
      return nullableString(payload.runId) ? [{ kind: 'run', recordId: String(payload.runId) }] : []
    case 'review':
      return reviewRunIds(database, row.record_id).map((recordId) => ({ kind: 'run', recordId }))
    case 'review_lens':
      return [
        { kind: 'run', recordId: nullableString(payload.runId) },
        { kind: 'review', recordId: nullableString(payload.reviewId) },
      ].filter((value): value is ParentRef => value.recordId !== null)
    case 'review_finding': {
      const lensId = nullableString(payload.reviewLensId)
      return [
        { kind: 'review', recordId: nullableString(payload.reviewId) },
        { kind: 'review_lens', recordId: lensId },
        { kind: 'run', recordId: lensId ? lensRunId(database, lensId) : null },
      ].filter((value): value is ParentRef => value.recordId !== null)
    }
    default:
      return []
  }
}

export function blockedByRetiredParentRows(database: Database): BlockedOutboxRow[] {
  const rows = database
    .query<OutboxRow, []>(
      `SELECT id,kind,record_id,payload FROM outbox
       WHERE synced_at IS NULL AND quarantined_at IS NULL AND retired_at IS NULL ORDER BY id`,
    )
    .all()
  const blocked: BlockedOutboxRow[] = []
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.payload)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const dependency = outboxDependency(row, parsed as Payload, database)
    if (dependency.disposition === 'blocked') {
      blocked.push({ id: row.id, kind: row.kind, parentRecordId: dependency.parentRecordId! })
    }
  }
  return blocked
}

function outboxDependencyState(
  database: Database,
  parents: readonly ParentRef[],
): { disposition: 'ready' | 'deferred' | 'blocked'; parentRecordId?: string } {
  const unique = new Map(parents.map((parent) => [`${parent.kind}:${parent.recordId}`, parent]))
  let deferred = false
  for (const { kind, recordId: parentRecordId } of unique.values()) {
    const rows = database
      .query<ParentState, [string, string]>(
        `SELECT synced_at,quarantined_at,retired_at FROM outbox
         WHERE kind=? AND record_id=? ORDER BY id DESC`,
      )
      .all(kind, parentRecordId)
    const latest = rows[0]
    if (!latest || latest.synced_at !== null) continue
    if (latest.retired_at === null) {
      deferred = true
      continue
    }
    return { disposition: 'blocked', parentRecordId }
  }
  return { disposition: deferred ? 'deferred' : 'ready' }
}

function outboxDependency(row: OutboxRow, payload: Payload, database: Database) {
  return outboxDependencyState(database, outboxParentRecordIds(row, payload, database))
}

export function deferOutboxRow(
  database: Database,
  row: OutboxRow,
  payload: Payload,
  blocked: BlockedOutboxRow[],
): boolean {
  const dependency = outboxDependency(row, payload, database)
  if (dependency.disposition === 'ready') return false
  if (dependency.disposition === 'blocked') {
    blocked.push({ id: row.id, kind: row.kind, parentRecordId: dependency.parentRecordId! })
  }
  return true
}

export function outboxRowIsEligible(database: Database, row: OutboxRow): boolean {
  return Boolean(
    database
      .query<{ id: number }, [number, string]>(
        `SELECT id FROM outbox WHERE id=? AND payload=? AND synced_at IS NULL
         AND quarantined_at IS NULL AND retired_at IS NULL`,
      )
      .get(row.id, row.payload),
  )
}

export function markOutboxRowSynced(database: Database, row: OutboxRow, at: string): boolean {
  return Boolean(
    database
      .query(
        `UPDATE outbox SET synced_at=?, last_error=NULL WHERE id=? AND payload=?
         AND synced_at IS NULL AND quarantined_at IS NULL AND retired_at IS NULL`,
      )
      .run(at, row.id, row.payload).changes,
  )
}
