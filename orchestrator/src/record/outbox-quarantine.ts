// concern: outbox-quarantine
/** Owns local quarantine state and its append-only operator audit. */
import type { Database } from 'bun:sqlite'
import { db, nowIso, sessionId, writeTransaction } from '../database/db.ts'

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
  record_id: string
  attempts: number
  quarantine_reason: string | null
  quarantined_at: string | null
  retired_at: string | null
}

function outboxRow(database: Database, rowId: number): OutboxIdentity {
  const row = database
    .query<OutboxIdentity, [number]>(
      `SELECT id,kind,record_id,attempts,quarantine_reason,quarantined_at,retired_at
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
      `outbox row ${rowId} is not quarantined; run \`orch sync\` and use retry or retire only after the row is reported as quarantined`,
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
       (outbox_id,kind,record_id,error,attempts,disposition,actor_session,at,reason)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id,
      row.kind,
      row.record_id,
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

export function retireOutboxRow(
  rowId: number,
  reason: string,
  database: Database = db(),
  at = nowIso(),
  actorSession = sessionId(),
): void {
  const trimmed = reason.trim()
  if (!trimmed) throw new Error('retiring an outbox row requires a non-empty --reason')
  writeTransaction(() => {
    const row = quarantinedRow(database, rowId)
    audit(database, row, 'retire', row.quarantine_reason, trimmed, actorSession, at)
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
        record_id: string
        quarantine_reason: string
        attempts: number
        quarantined_at: string
      },
      []
    >(
      `SELECT id,kind,record_id,quarantine_reason,attempts,quarantined_at
         FROM outbox WHERE quarantined_at IS NOT NULL AND retired_at IS NULL ORDER BY id`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      recordId: row.record_id,
      error: row.quarantine_reason,
      attempts: row.attempts,
      quarantinedAt: row.quarantined_at,
    }))
}
