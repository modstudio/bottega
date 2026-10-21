// concern: run-startup-failure
/** Records and publishes startup failures before or after a run is claimed. */
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { rollUpRootAndEnqueue } from './run-liveness.ts'
import { enqueueRunRecord } from './run-outbox.ts'

function enqueueFailedReservedRun(
  reserveId: string,
  database: ReturnType<typeof db>,
  localMachineId: string,
  finishedAt: string,
): void {
  const reserved = database
    .query('SELECT parent_run_record_id FROM run WHERE record_id=?')
    .get(reserveId) as { parent_run_record_id: string | null } | null
  enqueueRunRecord(database, reserveId, localMachineId, finishedAt)
  if (reserved?.parent_run_record_id)
    rollUpRootAndEnqueue(database, reserved.parent_run_record_id, null, localMachineId, finishedAt)
}

export function publishFailedReservedRun(reserveId: string): void {
  const finishedAt = nowIso()
  const localMachineId = machineId()
  writeTransaction(() => {
    const database = db()
    const failed = database
      .query("SELECT 1 AS failed FROM run WHERE record_id=? AND status='failed'")
      .get(reserveId)
    if (failed) enqueueFailedReservedRun(reserveId, database, localMachineId, finishedAt)
  })
}

export function recordRunStartupFailure(
  reserveId: string | undefined,
  error: unknown,
  started?: number,
): void {
  if (!reserveId) return
  const message = error instanceof Error ? error.message : String(error)
  const finishedAt = nowIso()
  const localMachineId = machineId()
  writeTransaction(() => {
    const database = db()
    const changed = database
      .query(
        `UPDATE run SET status='failed', failure_kind='harness', error=?, latency_ms=?
         WHERE record_id=? AND status='running'`,
      )
      .run(message, started === undefined ? 0 : Date.now() - started, reserveId).changes
    if (changed !== 1) return
    enqueueFailedReservedRun(reserveId, database, localMachineId, finishedAt)
  })
}
