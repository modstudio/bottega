// concern: outbox-quarantine
/** Owns local quarantine state and its append-only operator audit. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, sessionId, writeTransaction } from '../database/db.ts'
import { OUTBOX_HELD_FOR_UPGRADE_MARKER } from './outbox-held-contract.ts'
export type QuarantinedOutboxRow = {
  id: number
  kind: string
  recordId: string
  error: string
  attempts: number
  quarantinedAt: string
}

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
): void {
  writeTransaction(() => {
    const row = quarantinedRow(database, rowId)
    audit(
      database,
      row,
      'retry',
      row.quarantine_reason,
      'operator requested retry',
      actorSession,
      at,
    )
    database
      .query(
        `UPDATE outbox SET quarantined_at=NULL,quarantine_reason=NULL,last_error=NULL
         WHERE id=?`,
      )
      .run(rowId)
  }, database)
}

export function retryOutboxRowsMatching(
  matching: string,
  database: Database = db(),
  at = nowIso(),
  actorSession = sessionId(),
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
  for (const row of rows) retryOutboxRow(row.id, database, at, actorSession)
  return rows.length
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
    const row = candidate
    audit(
      database,
      row,
      'retire',
      row.quarantine_reason ?? row.last_error,
      trimmed,
      actorSession,
      at,
    )
    database
      .query('UPDATE outbox SET retired_at=?,retirement_reason=? WHERE id=?')
      .run(at, trimmed, rowId)
  }, database)
}

export function quarantinedOutboxRows(database: Database = db()): QuarantinedOutboxRow[] {
  return database
    .query<
      {
        id: number
        kind: string
        row_id: string
        quarantine_reason: string
        attempts: number
        quarantined_at: string
      },
      []
    >(
      `SELECT id,kind,row_id,quarantine_reason,attempts,quarantined_at
         FROM outbox WHERE quarantined_at IS NOT NULL AND retired_at IS NULL ORDER BY id`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      recordId: row.row_id,
      error: row.quarantine_reason,
      attempts: row.attempts,
      quarantinedAt: row.quarantined_at,
    }))
}
