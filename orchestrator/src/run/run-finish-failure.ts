// concern: run-finish-failure
/** Decides and records whether a finish-path failure may replace the run's current outcome. */
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { enqueueRunRecord } from './run-outbox.ts'
import { TERMINAL_RUN_STATUS_SET } from './run-status.ts'
import { finalizeTerminalChain } from './run-terminal-chain.ts'

export function shouldWriteFinishFailure(
  currentStatus: string,
  terminalRecorded: boolean,
): boolean {
  return !terminalRecorded && !TERMINAL_RUN_STATUS_SET.has(currentStatus)
}

export function recordRunFinishFailure(input: {
  runId: string
  error: unknown
  started: number
  machineId: string
  terminalRecorded: boolean
}): void {
  const detail = input.error instanceof Error ? input.error.message : String(input.error)
  const finishedAt = nowIso()
  writeTransaction(() => {
    const database = db()
    const row = database
      .query('SELECT status,parent_run_record_id FROM run WHERE record_id=?')
      .get(input.runId) as {
      status: string
      parent_run_record_id: string | null
    } | null
    if (!row || !shouldWriteFinishFailure(row.status, input.terminalRecorded)) return
    const error = `finish failed: ${detail}`
    const changed = database
      .query(
        `UPDATE run SET status='failed', failure_kind='harness', error=?, latency_ms=?
         WHERE record_id=? AND status=?`,
      )
      .run(error, Date.now() - input.started, input.runId, row.status).changes
    if (changed !== 1) return
    finalizeTerminalChain(database, {
      runId: input.runId,
      parentRunId: row.parent_run_record_id,
      status: 'failed',
      failureKind: 'harness',
      error,
      record: [input.machineId, finishedAt],
    })
    enqueueRunRecord(database, input.runId, input.machineId, finishedAt)
  })
}
