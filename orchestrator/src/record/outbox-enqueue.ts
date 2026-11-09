// concern: outbox-enqueue
/** Owns insertion of pending hosted-record evidence and its best-effort sync signal. */

import type { Database } from 'bun:sqlite'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import {
  RECORD_SYNC_PENDING_MARKER,
  recordSyncQueueDirectory,
  type StateEnvironment,
} from '../../../shared/state-directory.ts'
import { sessionId } from '../database/session-identity.ts'
import { afterWriteCommit } from '../database/write-commit-effects.ts'
import { stringifyOutboxPayload } from './outbox-sanitize.ts'

export type OutboxInsert = {
  recordId: string
  kind: string
  rowId: string
  payload: string
  createdAt: string
}

export type PendingOutboxRefresh = {
  id: number
  payload: string
  createdAt: string
}

const RECORD_SYNC_EFFECT = 'record-sync'

/** Signal launchd without allowing marker failures to affect the database write. */
function signalRecordSync(env: StateEnvironment = process.env): void {
  try {
    const directory = recordSyncQueueDirectory(env)
    mkdirSync(directory, { recursive: true })
    closeSync(openSync(join(directory, RECORD_SYNC_PENDING_MARKER), 'w'))
  } catch {
    // StartInterval remains the retry and missed-signal backstop.
  }
}

/** Request record sync after the owning transaction commits. */
export function signalRecordSyncAfterWriteCommit(
  database: Database,
  env: StateEnvironment = process.env,
): void {
  afterWriteCommit(database, () => signalRecordSync(env), RECORD_SYNC_EFFECT)
}

/** Insert one outbox row with the caller's values, then request prompt record sync. */
export function insertOutboxRow(
  database: Database,
  row: OutboxInsert,
  env: StateEnvironment = process.env,
): number {
  const inserted = database
    .query<{ id: number }, [string, string, string, string, string, string | null]>(
      `INSERT INTO outbox (record_id,kind,row_id,payload,created_at,actor_session)
       VALUES (?,?,?,?,?,?) RETURNING id`,
    )
    .get(row.recordId, row.kind, row.rowId, row.payload, row.createdAt, sessionId(database))!
  signalRecordSyncAfterWriteCommit(database, env)
  return inserted.id
}

/** Refresh one pending outbox row, then request prompt record sync. */
export function refreshPendingOutboxRow(
  database: Database,
  row: PendingOutboxRefresh,
  env: StateEnvironment = process.env,
): void {
  database
    .query('UPDATE outbox SET payload=?,created_at=?,attempts=0,last_error=NULL WHERE id=?')
    .run(row.payload, row.createdAt, row.id)
  signalRecordSyncAfterWriteCommit(database, env)
}

/** Rewrite pending payloads in place, then request prompt record sync when any changed. */
export function rewritePendingOutboxPayloads(
  database: Database,
  rewrite: (kind: string, payload: Record<string, unknown>) => boolean,
  env: StateEnvironment = process.env,
): number {
  const rows = database
    .query<{ id: number; kind: string; payload: string }, []>(
      'SELECT id,kind,payload FROM outbox WHERE synced_at IS NULL',
    )
    .all()
  let rewritten = 0
  for (const row of rows) {
    let payload: unknown
    try {
      payload = JSON.parse(row.payload)
    } catch {
      continue
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
    if (!rewrite(row.kind, payload as Record<string, unknown>)) continue
    rewritten += database
      .query('UPDATE outbox SET payload=? WHERE id=? AND payload=? AND synced_at IS NULL')
      .run(
        stringifyOutboxPayload(row.kind, payload as Record<string, unknown>, {
          sanitizedForRules: true,
        }),
        row.id,
        row.payload,
      ).changes
  }
  if (rewritten > 0) signalRecordSyncAfterWriteCommit(database, env)
  return rewritten
}
