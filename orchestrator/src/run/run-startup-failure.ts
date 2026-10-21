// concern: run-startup-failure
/** Keep a reserved run queryable when coordinator setup refuses before claim. */
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { enqueueRunRecord } from './run-outbox.ts'

export function failReservedRun(reserveId: string | undefined, error: unknown): void {
  if (!reserveId) return
  const message = error instanceof Error ? error.message : String(error)
  const finishedAt = nowIso()
  writeTransaction(() => {
    const changed = db()
      .query(
        `UPDATE run SET status='failed', failure_kind='harness', error=?, latency_ms=0
         WHERE record_id=? AND status='running'`,
      )
      .run(message, reserveId).changes
    if (changed === 1) enqueueRunRecord(db(), reserveId, machineId(), finishedAt)
  })
}
