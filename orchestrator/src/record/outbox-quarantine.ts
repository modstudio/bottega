// concern: outbox-quarantine
/** Owns local quarantine state and its append-only operator audit. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import type { StateEnvironment } from '../../../shared/state-directory.ts'
import { db, nowIso, sessionId, writeTransaction } from '../database/db.ts'
import { signalRecordSyncAfterWriteCommit } from './outbox-enqueue.ts'
import { OUTBOX_HELD_FOR_UPGRADE_MARKER } from './outbox-held-contract.ts'
import {
  PENDING_OUTBOX_PREDICATE_SQL,
  QUARANTINED_UNRETIRED_OUTBOX_PREDICATE_SQL,
} from './outbox-read.ts'
export type QuarantinedOutboxRow = {
  id: number
  kind: string
  recordId: string
  payload: string
  error: string
  attempts: number
  quarantinedAt: string
}

export type QuarantinedOutboxRowSummary = Omit<QuarantinedOutboxRow, 'payload'>

export const QUARANTINED_OUTBOX_ROWS_SQL = `SELECT id,kind,row_id,payload,quarantine_reason,attempts,quarantined_at
  FROM outbox WHERE ${QUARANTINED_UNRETIRED_OUTBOX_PREDICATE_SQL} ORDER BY id`

type OutboxIdentity = {
  id: number
  kind: string
  row_id: string
  attempts: number
  last_error: string | null
  quarantine_reason: string | null
  quarantined_at: string | null
  retired_at: string | null
}

function outboxRow(database: Database, rowId: number): OutboxIdentity {
  const row = database
    .query<OutboxIdentity, [number]>(
      `SELECT id,kind,row_id,attempts,last_error,quarantine_reason,quarantined_at,retired_at
         FROM outbox WHERE id=?`,
    )
    .get(rowId)
  if (!row) {
    throw new Error(
      `outbox row ${rowId} is unknown; inspect the local outbox and retry with an existing row id`,
    )
  }
  return row
}

function quarantinedRow(database: Database, rowId: number): OutboxIdentity {
  const row = outboxRow(database, rowId)
  if (row.retired_at) {
    throw new Error(
      `outbox row ${rowId} is retired and permanently not deliverable; inspect its outbox quarantine audit instead`,
    )
  }
  if (!row.quarantined_at) {
    throw new Error(
      `outbox row ${rowId} is not quarantined; run \`${PLATFORM_SLUG} record sync\` and use retry or retire only after the row is reported as quarantined`,
    )
  }
  return row
}

function audit(
  database: Database,
  row: OutboxIdentity,
  disposition: 'quarantine' | 'retry' | 'retire',
  error: string | null,
  reason: string | null,
  actorSession: string | null,
  at: string,
): void {
  database
    .query(
      `INSERT INTO outbox_quarantine_audit
       (record_id,outbox_id,kind,row_id,error,attempts,disposition,actor_session,at,reason)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      row.id,
      row.kind,
      row.row_id,
      error,
      row.attempts,
      disposition,
      actorSession,
      at,
      reason,
    )
}

/** Retire pending rows for outbox kinds whose delivery path has been removed. */
export function retirePendingOutboxKinds(
  database: Database,
  kinds: ReadonlySet<string>,
  reason: string,
  at = nowIso(),
): number {
  if (kinds.size === 0) return 0
  return writeTransaction(() => {
    const rows = database
      .query<OutboxIdentity, string[]>(
        `SELECT id,kind,row_id,attempts,last_error,quarantine_reason,quarantined_at,retired_at
           FROM outbox
          WHERE kind IN (${[...kinds].map(() => '?').join(',')})
            AND ${PENDING_OUTBOX_PREDICATE_SQL}
          ORDER BY id`,
      )
      .all(...kinds)
    for (const row of rows) {
      audit(database, row, 'retire', row.last_error, reason, null, at)
      database
        .query('UPDATE outbox SET retired_at=?,retirement_reason=? WHERE id=?')
        .run(at, reason, row.id)
    }
    return rows.length
  }, database)
}

export function quarantineOutboxRow(
  database: Database,
  rowId: number,
  payload: string,
  error: string,
  at = nowIso(),
  actorSession = sessionId(),
): boolean {
  return writeTransaction(() => {
    const changed = database
      .query(
        `UPDATE outbox SET attempts=attempts+1,last_error=?,quarantined_at=?,quarantine_reason=?
         WHERE id=? AND payload=? AND quarantined_at IS NULL AND retired_at IS NULL`,
      )
      .run(error, at, error, rowId, payload).changes
    if (!changed) return false
    const row = outboxRow(database, rowId)
    audit(database, row, 'quarantine', error, error, actorSession, at)
    return true
  }, database)
}

export function retryOutboxRow(
  rowId: number,
  database: Database = db(),
  at = nowIso(),
  actorSession = sessionId(),
  env: StateEnvironment = process.env,
): void {
  writeTransaction(() => {
    retryOutboxRowInWriteTransaction(rowId, database, at, actorSession, env)
  }, database)
}

function retryOutboxRowWithoutSignal(
  rowId: number,
  database: Database,
  at: string,
  actorSession: string | null,
): void {
  const row = quarantinedRow(database, rowId)
  audit(database, row, 'retry', row.quarantine_reason, 'operator requested retry', actorSession, at)
  database
    .query(
      `UPDATE outbox SET quarantined_at=NULL,quarantine_reason=NULL,last_error=NULL
       WHERE id=?`,
    )
    .run(rowId)
}

function retryOutboxRowInWriteTransaction(
  rowId: number,
  database: Database,
  at: string,
  actorSession: string | null,
  env: StateEnvironment = process.env,
): void {
  retryOutboxRowWithoutSignal(rowId, database, at, actorSession)
  signalRecordSyncAfterWriteCommit(database, env)
}

/** Retry matching rows and request record sync after the owning transaction commits. */
export function retryOutboxRowsMatchingInWriteTransaction(
  matching: string,
  database: Database,
  at = nowIso(),
  actorSession = sessionId(),
  env: StateEnvironment = process.env,
): number {
  const rows = database
    .query<{ id: number }, [string]>(
      `SELECT id FROM outbox
       WHERE quarantined_at IS NOT NULL
         AND retired_at IS NULL
         AND instr(quarantine_reason, ?) > 0
       ORDER BY id`,
    )
    .all(matching)
  for (const row of rows) retryOutboxRowWithoutSignal(row.id, database, at, actorSession)
  if (rows.length > 0) signalRecordSyncAfterWriteCommit(database, env)
  return rows.length
}

export function retryOutboxRowsMatching(
  matching: string,
  database: Database = db(),
  at = nowIso(),
  actorSession = sessionId(),
  env: StateEnvironment = process.env,
): number {
  const retried = writeTransaction(
    () => retryOutboxRowsMatchingInWriteTransaction(matching, database, at, actorSession, env),
    database,
  )
  return retried
}

export function retireOutboxRow(
  rowId: number,
  reason: string,
  database: Database = db(),
  at = nowIso(),
  actorSession = sessionId(),
  additionalEligibility?: (database: Database, rowId: number) => boolean,
): void {
  const trimmed = reason.trim()
  if (!trimmed) throw new Error('retiring an outbox row requires a non-empty --reason')
  writeTransaction(() => {
    const candidate = outboxRow(database, rowId)
    if (candidate.retired_at) {
      throw new Error(
        `outbox row ${rowId} is retired and permanently not deliverable; inspect its outbox quarantine audit instead`,
      )
    }
    const held = candidate.last_error?.startsWith(OUTBOX_HELD_FOR_UPGRADE_MARKER) ?? false
    const blocked =
      candidate.quarantined_at || held ? false : additionalEligibility?.(database, rowId)
    if (!candidate.quarantined_at && !held && !blocked) {
      throw new Error(
        `outbox row ${rowId} is not quarantined, held for upgrade, or blocked by a retired parent; run \`${PLATFORM_SLUG} record sync\` and retire only a reported row`,
      )
    }
    retireOutboxIdentity(database, candidate, trimmed, at, actorSession)
  }, database)
}

function retireOutboxIdentity(
  database: Database,
  row: OutboxIdentity,
  reason: string,
  at: string,
  actorSession: string | null,
): void {
  audit(database, row, 'retire', row.quarantine_reason ?? row.last_error, reason, actorSession, at)
  database
    .query('UPDATE outbox SET retired_at=?,retirement_reason=? WHERE id=?')
    .run(at, reason, row.id)
}

/** Automatically retires a still-quarantined row, skipping concurrent disposal. */
export function retireQuarantinedOutboxRowIfEligible(
  rowId: number,
  reason: string,
  database: Database,
  at = nowIso(),
  actorSession: string | null = null,
): boolean {
  const trimmed = reason.trim()
  if (!trimmed) throw new Error('retiring an outbox row requires a non-empty reason')
  return writeTransaction(() => {
    const candidate = outboxRow(database, rowId)
    if (candidate.retired_at || !candidate.quarantined_at) return false
    retireOutboxIdentity(database, candidate, trimmed, at, actorSession)
    return true
  }, database)
}

export function quarantinedOutboxRows(database: Database = db()): QuarantinedOutboxRow[] {
  return database
    .query<
      {
        id: number
        kind: string
        row_id: string
        payload: string
        quarantine_reason: string
        attempts: number
        quarantined_at: string
      },
      []
    >(QUARANTINED_OUTBOX_ROWS_SQL)
    .all()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      recordId: row.row_id,
      payload: row.payload,
      error: row.quarantine_reason,
      attempts: row.attempts,
      quarantinedAt: row.quarantined_at,
    }))
}

/** Removes the internal payload used to choose a quarantine remedy from public status output. */
export function quarantinedOutboxRowSummary(
  row: QuarantinedOutboxRow,
): QuarantinedOutboxRowSummary {
  const { payload: _payload, ...summary } = row
  return summary
}
