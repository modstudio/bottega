// concern: run-question-readiness
/** Makes a run answerable before its question crosses the hosted-record boundary. */

import type { Database } from 'bun:sqlite'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { runQuestionOwnerLive } from '../question-store/run-question-write-guard.ts'
import { enqueueRunRecord } from './run-outbox.ts'

/** Apply the one running-to-asking transition shared by every question channel. */
function markRunAsking(database: Database, runId: string): void {
  database.query("UPDATE run SET status='asking' WHERE record_id=? AND status='running'").run(runId)
}

export function restoreRunAfterQuestionRefusal(
  database: Database,
  input: { runId: string; machineId: string; transitioned: boolean; recordedAt: string },
): void {
  if (!input.transitioned) return
  writeTransaction(() => {
    database
      .query("UPDATE run SET status='running' WHERE record_id=? AND status='asking'")
      .run(input.runId)
    enqueueRunRecord(database, input.runId, input.machineId, input.recordedAt)
  }, database)
}

export function claimLiveRunQuestionChannel(
  database: Database,
  runId: string,
): { live: boolean; transitioned: boolean } {
  const transition = database
    .query("UPDATE run SET status='asking' WHERE record_id=? AND status='running'")
    .run(runId)
  const owner = database
    .query<{ status: string }, [string]>('SELECT status FROM run WHERE record_id=?')
    .get(runId)
  return {
    live: owner?.status === 'asking' && runQuestionOwnerLive(owner.status),
    transitioned: transition.changes > 0,
  }
}

/** Persist the facts needed to answer or resume a reply-borne question. */
export function recordRunQuestionReadiness(
  input: { machineId: string; resolvedSession: string | null },
  runId: string,
  questions: readonly unknown[],
): void {
  const database = db(true)
  writeTransaction(() => {
    database
      .query('UPDATE run SET vendor_session=COALESCE(?, vendor_session) WHERE record_id=?')
      .run(input.resolvedSession, runId)
    if (questions.length) markRunAsking(database, runId)
    enqueueRunRecord(database, runId, input.machineId, nowIso())
  }, database)
}
