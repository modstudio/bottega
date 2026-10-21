// concern: outbox-dependency
/** Resolves local outbox parent state without knowing how hosted rows are sent. */
import type { Database } from 'bun:sqlite'
import { evidenceReferences } from './record-evidence-references.ts'
import type { BlockedOutboxRow, OutboxRow, Payload } from './record-sync-types.ts'

type ParentRef = { kind: string; recordId: string; blockedReason?: string }

type ParentState = {
  synced_at: string | null
  quarantined_at: string | null
  retired_at: string | null
}

function localRunIsLive(database: Database, recordId: string): boolean {
  return Boolean(
    database
      .query<{ found: number }, [string]>(
        `SELECT 1 AS found FROM run WHERE record_id=?
         AND status NOT IN ('ok','failed','stale','stopped')`,
      )
      .get(recordId),
  )
}

export const outboxParentIdentityKey = (kind: string, recordId: string): string =>
  `${kind}:${recordId}`

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
       JOIN review_lens ON review_lens.review_record_id=review.record_id
       JOIN run ON run.record_id=review_lens.run_record_id
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
       JOIN run ON run.record_id=review_lens.run_record_id
       WHERE review_lens.record_id=? AND run.record_id IS NOT NULL`,
    )
    .get(lensRecordId)
  if (normalized) return { runId: normalized.record_id, unreadable: false }
  const row = database
    .query<{ payload: string }, [string]>(
      `SELECT payload FROM outbox WHERE kind='review_lens' AND row_id=? ORDER BY id DESC LIMIT 1`,
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
  const hostedParents: ParentRef[] = evidenceReferences(row.kind, payload).map((reference) => ({
    kind: reference.table,
    recordId: reference.id,
  }))
  switch (row.kind) {
    case 'review':
      return [
        ...hostedParents,
        ...reviewRunIds(database, row.row_id).map((recordId) => ({ kind: 'run', recordId })),
      ]
    case 'review_finding': {
      const lensId = nullableString(payload.reviewLensId)
      const lens = lensId ? lensRun(database, lensId) : { runId: null, unreadable: false }
      return [
        ...hostedParents.map((parent) =>
          parent.kind === 'review_lens' && lens.unreadable
            ? {
                ...parent,
                blockedReason: `review_lens parent ${parent.recordId} has an unreadable stored payload and no local normalized run`,
              }
            : parent,
        ),
        { kind: 'run', recordId: lens.runId },
      ].filter((value): value is ParentRef => value.recordId !== null)
    }
    default:
      return hostedParents
  }
}

export function blockedByRetiredParentRows(database: Database): BlockedOutboxRow[] {
  const rows = database
    .query<OutboxRow, []>(
      `SELECT id,kind,row_id,payload FROM outbox
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
  plannedParents?: ReadonlyMap<string, readonly number[]>,
): { disposition: 'ready' | 'deferred' | 'blocked'; parentRecordId?: string; reason?: string } {
  const unique = new Map(
    parents.map((parent) => [outboxParentIdentityKey(parent.kind, parent.recordId), parent]),
  )
  let deferred = false
  for (const { kind, recordId: parentRecordId, blockedReason } of unique.values()) {
    if (plannedParents?.has(outboxParentIdentityKey(kind, parentRecordId))) continue
    const rows = database
      .query<ParentState, [string, string]>(
        `SELECT synced_at,quarantined_at,retired_at FROM outbox
         WHERE kind=? AND row_id=? ORDER BY id DESC`,
      )
      .all(kind, parentRecordId)
    const latest = rows[0]
    if (!latest) {
      if (kind === 'run' && localRunIsLive(database, parentRecordId)) deferred = true
      continue
    }
    if (rows.some((row) => row.synced_at !== null)) continue
    if (latest.retired_at === null) {
      deferred = true
      continue
    }
    return { disposition: 'blocked', parentRecordId, reason: blockedReason }
  }
  return { disposition: deferred ? 'deferred' : 'ready' }
}

function outboxDependency(
  row: OutboxRow,
  payload: Payload,
  database: Database,
  plannedParents?: ReadonlyMap<string, readonly number[]>,
) {
  return outboxDependencyState(
    database,
    outboxParentRecordIds(row, payload, database),
    plannedParents,
  )
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
      `SELECT id,kind,row_id,payload FROM outbox WHERE id=?
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
  plannedParents?: ReadonlyMap<string, readonly number[]>,
): boolean {
  const dependency = outboxDependency(row, payload, database, plannedParents)
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

export function outboxRowWaitsForParent(
  database: Database,
  row: OutboxRow,
  payload: Payload,
  plannedParents?: ReadonlyMap<string, readonly number[]>,
): boolean {
  return outboxDependency(row, payload, database, plannedParents).disposition === 'deferred'
}

export function outboxRowPlannedParentKeys(
  database: Database,
  row: OutboxRow,
  payload: Payload,
  plannedParents: ReadonlyMap<string, readonly number[]>,
): string[] {
  const parents = new Map(
    outboxParentRecordIds(row, payload, database).map((parent) => [
      outboxParentIdentityKey(parent.kind, parent.recordId),
      parent,
    ]),
  )
  return [...parents].flatMap(([key, parent]) =>
    plannedParents.has(key) && outboxDependencyState(database, [parent]).disposition === 'deferred'
      ? [key]
      : [],
  )
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
