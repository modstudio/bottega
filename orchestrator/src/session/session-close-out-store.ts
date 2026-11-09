// concern: session close-out store
/** Owns persistence and retention for machine-local session close-out records. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, writableDb } from '../database/db.ts'
import type { SessionCloseOutRecord } from './session-close-out-decision.ts'

export type SessionCloseOutRow = {
  record_id: string
  session_id: string
  closed_at: string
  clean: number
  recommendation: 'clear' | 'brief'
  mechanical_count: number
  process_count: number
  error_count: number
  warning_count: number
  swept_at: string | null
  last_seen: string | null
}

export function insertSessionCloseOutRecord(
  record: SessionCloseOutRecord,
  database: Database = writableDb(),
  closedAt = new Date().toISOString(),
): void {
  database
    .query(
      `INSERT INTO session_close_out
       (record_id,session_id,closed_at,clean,recommendation,mechanical_count,process_count,error_count,warning_count)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      record.sessionId,
      closedAt,
      record.clean ? 1 : 0,
      record.recommendation,
      record.mechanicalCount,
      record.processCount,
      record.errorCount,
      record.warningCount,
    )
}

/** Read exactly the newest close-out per session before deciding whether it is actionable. */
export function newestSessionCloseOutRecords(database: Database = db()): SessionCloseOutRow[] {
  return database
    .query(
      `SELECT close_out.record_id,close_out.session_id,close_out.closed_at,close_out.clean,
              close_out.recommendation,close_out.mechanical_count,close_out.process_count,
              close_out.error_count,close_out.warning_count,close_out.swept_at,seen.last_seen
         FROM session_close_out close_out
         LEFT JOIN session_seen seen ON seen.session_id=close_out.session_id
        WHERE NOT EXISTS (
          SELECT 1 FROM session_close_out newer
           WHERE newer.session_id=close_out.session_id
             AND (newer.closed_at>close_out.closed_at OR
               (newer.closed_at=close_out.closed_at AND newer.record_id>close_out.record_id))
        )
        ORDER BY close_out.session_id`,
    )
    .all() as SessionCloseOutRow[]
}

export function sessionCloseOutLastSeen(session: string, database: Database = db()): string | null {
  const row = database
    .query('SELECT last_seen FROM session_seen WHERE session_id=?')
    .get(session) as { last_seen: string } | null
  return row?.last_seen ?? null
}

export function markSessionCloseOutSwept(
  recordId: string,
  sweptAt: string,
  database: Database = writableDb(),
): number {
  return database
    .query('UPDATE session_close_out SET swept_at=? WHERE record_id=? AND swept_at IS NULL')
    .run(sweptAt, recordId).changes
}

/** Remove every close-out row after its swept or unswept retention anchor ages out. */
export function pruneSessionCloseOutRecords(
  cutoff: string,
  database: Database = writableDb(),
): number {
  return database
    .query('DELETE FROM session_close_out WHERE COALESCE(swept_at,closed_at)<?')
    .run(cutoff).changes
}
