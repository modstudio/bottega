// concern: run-startup-failure
/** Keep a reserved run queryable when coordinator setup refuses before claim. */
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { rollUpRootAndEnqueue } from './run-liveness.ts'
import { enqueueRunRecord } from './run-outbox.ts'

export function failReservedRun(reserveId: string | undefined, error: unknown): void {
  if (!reserveId) return
  const message = error instanceof Error ? error.message : String(error)
  const finishedAt = nowIso()
  const localMachineId = machineId()
  writeTransaction(() => {
    const database = db()
    const reserved = database
      .query('SELECT parent_run_record_id FROM run WHERE record_id=?')
      .get(reserveId) as { parent_run_record_id: string | null } | null
    const changed = database
      .query(
        `UPDATE run SET status='failed', failure_kind='harness', error=?, latency_ms=0
         WHERE record_id=? AND status='running'`,
      )
      .run(message, reserveId).changes
    if (changed !== 1) return
    enqueueRunRecord(database, reserveId, localMachineId, finishedAt)
    if (reserved?.parent_run_record_id)
      rollUpRootAndEnqueue(
        database,
        reserved.parent_run_record_id,
        null,
        localMachineId,
        finishedAt,
      )
  })
}
