// concern: worker record read request lifecycle
/** DB-backed handoff from a sandbox ask server to the host run supervisor. */

import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, writableDb } from '../database/db.ts'

export const WORKER_RECORD_READ_POLL_MS = 100
export const WORKER_RECORD_READ_DEADLINE_MS = 30_000

export type WorkerRecordReadKind = 'task' | 'task-document' | 'workflow-text'

export async function requestWorkerRecordRead(input: {
  runId: string
  kind: WorkerRecordReadKind
  reference: string
  project?: string
}): Promise<string> {
  writableDb()
  const recordId = newRecordId()
  db()
    .query(
      `INSERT INTO worker_record_read_request
       (record_id,run_record_id,kind,reference,project,status,requested_at)
       VALUES (?,?,?,?,?,'requested',?)`,
    )
    .run(recordId, input.runId, input.kind, input.reference, input.project ?? null, nowIso())
  const deadline = Date.now() + WORKER_RECORD_READ_DEADLINE_MS
  try {
    while (Date.now() < deadline) {
      const row = db()
        .query(
          `SELECT status,result,refusal FROM worker_record_read_request WHERE record_id=?`,
        )
        .get(recordId) as {
        status: 'requested' | 'result' | 'refused'
        result: string | null
        refusal: string | null
      } | null
      if (!row) throw new Error('worker record read request disappeared before it was answered')
      if (row.status === 'result' && row.result) return row.result
      if (row.status === 'refused') throw new Error(row.refusal ?? 'worker record read was refused')
      await Bun.sleep(WORKER_RECORD_READ_POLL_MS)
    }
    throw new Error(
      `worker record read timed out after ${WORKER_RECORD_READ_DEADLINE_MS}ms waiting for the host broker`,
    )
  } finally {
    db().query('DELETE FROM worker_record_read_request WHERE record_id=?').run(recordId)
  }
}
