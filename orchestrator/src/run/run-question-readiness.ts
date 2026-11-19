// concern: run-question-readiness
/** Makes a run answerable before its question crosses the hosted-record boundary. */

import type { Database } from 'bun:sqlite'
import { nowIso, writeTransaction } from '../database/db.ts'
import { enqueueRunRecord } from './run-outbox.ts'

/** Apply the one running-to-asking transition shared by every question channel. */
export function markRunAsking(database: Database, runId: string): void {
  database.query("UPDATE run SET status='asking' WHERE record_id=? AND status='running'").run(runId)
}

/** Persist the facts needed to answer or resume a reply-borne question. */
export function recordRunQuestionReadiness<T extends readonly unknown[]>(
  input: { machineId: string },
  database: Database,
  runId: string,
  vendorSession: string | null,
  questions: T,
): T {
  writeTransaction(() => {
    database
      .query('UPDATE run SET vendor_session=COALESCE(?, vendor_session) WHERE record_id=?')
      .run(vendorSession, runId)
    if (questions.length) markRunAsking(database, runId)
    enqueueRunRecord(database, runId, input.machineId, nowIso())
  }, database)
  return questions
}
