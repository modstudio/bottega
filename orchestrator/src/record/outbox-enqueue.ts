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
import { afterWriteCommit } from '../database/write-commit-effects.ts'

export type OutboxInsert = {
  recordId: string
  kind: string
  rowId: string
  payload: string
  createdAt: string
}

/** Signal launchd without allowing marker failures to affect the database write. */
export function signalRecordSync(env: StateEnvironment = process.env): void {
  try {
    const directory = recordSyncQueueDirectory(env)
    mkdirSync(directory, { recursive: true })
    closeSync(openSync(join(directory, RECORD_SYNC_PENDING_MARKER), 'w'))
  } catch {
    // StartInterval remains the retry and missed-signal backstop.
  }
}

/** Insert one outbox row with the caller's values, then request prompt record sync. */
export function insertOutboxRow(
  database: Database,
  row: OutboxInsert,
  env: StateEnvironment = process.env,
): number {
  const inserted = database
    .query<{ id: number }, [string, string, string, string, string]>(
      `INSERT INTO outbox (record_id,kind,row_id,payload,created_at)
       VALUES (?,?,?,?,?) RETURNING id`,
    )
    .get(row.recordId, row.kind, row.rowId, row.payload, row.createdAt)!
  afterWriteCommit(database, () => signalRecordSync(env))
  return inserted.id
}
