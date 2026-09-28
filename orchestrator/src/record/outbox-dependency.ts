// concern: outbox-dependency
/** Resolves local outbox parent state without knowing how hosted rows are sent. */
import type { Database } from 'bun:sqlite'
import type { BlockedOutboxRow, OutboxRow, Payload } from './record-sync-types.ts'

type ParentRef = { kind: string; recordId: string; blockedReason?: string }

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

function lensRun(
  database: Database,
  lensRecordId: string,
): {
  runId: string | null
  unreadable: boolean
} {
  const normalized = database
    .query<{ record_id: string }, [string]>(
      `SELECT run.record_id FROM review_lens
       JOIN run ON run.id=review_lens.run_id
       WHERE review_lens.record_id=? AND run.record_id IS NOT NULL`,
    )
    .get(lensRecordId)
  if (normalized) return { runId: normalized.record_id, unreadable: false }
  const row = database
    .query<{ payload: string }, [string]>(
      `SELECT payload FROM outbox WHERE kind='review_lens' AND record_id=? ORDER BY id DESC LIMIT 1`,
    )
    .get(lensRecordId)
  if (!row) return { runId: null, unreadable: false }
  try {
    const payload = JSON.parse(row.payload) as unknown
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return { runId: null, unreadable: true }
    }
    return { runId: nullableString((payload as Payload).runId), unreadable: false }
  } catch {
    return { runId: null, unreadable: true }
  }
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
      const lens = lensId ? lensRun(database, lensId) : { runId: null, unreadable: false }
      return [
        { kind: 'review', recordId: nullableString(payload.reviewId) },
        {
          kind: 'review_lens',
          recordId: lensId,
          blockedReason: lens.unreadable
            ? `review_lens parent ${lensId} has an unreadable stored payload and no local normalized run`
            : undefined,
        },
        { kind: 'run', recordId: lens.runId },
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
    const blockedRow = blockedByRetiredParent(row, parsed as Payload, database)
    if (blockedRow) blocked.push(blockedRow)
  }
  return blocked
}

function outboxDependencyState(
  database: Database,
  parents: readonly ParentRef[],
): { disposition: 'ready' | 'deferred' | 'blocked'; parentRecordId?: string; reason?: string } {
  const unique = new Map(parents.map((parent) => [`${parent.kind}:${parent.recordId}`, parent]))
  let deferred = false
  for (const { kind, recordId: parentRecordId, blockedReason } of unique.values()) {
    const rows = database
      .query<ParentState, [string, string]>(
        `SELECT synced_at,quarantined_at,retired_at FROM outbox
         WHERE kind=? AND record_id=? ORDER BY id DESC`,
      )
      .all(kind, parentRecordId)
    const latest = rows[0]
    if (!latest || rows.some((row) => row.synced_at !== null)) continue
    if (latest.retired_at === null) {
      deferred = true
      continue
    }
    return { disposition: 'blocked', parentRecordId, reason: blockedReason }
  }
  return { disposition: deferred ? 'deferred' : 'ready' }
}

function outboxDependency(row: OutboxRow, payload: Payload, database: Database) {
  return outboxDependencyState(database, outboxParentRecordIds(row, payload, database))
}

function blockedByRetiredParent(
  row: OutboxRow,
  payload: Payload,
  database: Database,
): BlockedOutboxRow | null {
  const dependency = outboxDependency(row, payload, database)
  if (dependency.disposition !== 'blocked') return null
  return {
    id: row.id,
    kind: row.kind,
    parentRecordId: dependency.parentRecordId!,
    ...(dependency.reason ? { reason: dependency.reason } : {}),
  }
}

export function outboxRowBlockedByRetiredParent(
  database: Database,
  rowId: number,
): BlockedOutboxRow | null {
  const row = database
    .query<OutboxRow, [number]>(
      `SELECT id,kind,record_id,payload FROM outbox WHERE id=?
       AND synced_at IS NULL AND quarantined_at IS NULL AND retired_at IS NULL`,
    )
    .get(rowId)
  if (!row) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(row.payload)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return blockedByRetiredParent(row, parsed as Payload, database)
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
    blocked.push({
      id: row.id,
      kind: row.kind,
      parentRecordId: dependency.parentRecordId!,
      ...(dependency.reason ? { reason: dependency.reason } : {}),
    })
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
