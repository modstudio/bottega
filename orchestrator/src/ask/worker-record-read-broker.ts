// concern: host-side worker record read queue broker
/** Claims sandbox read requests and answers them through the canonical scope-checked handlers. */

import { isDatabaseLocked } from '../../../shared/database-lock-refusal.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import {
  readWorkerTask,
  readWorkerTaskDocument,
  readWorkerWorkflowText,
} from './worker-record-broker.ts'
import type { WorkerRecordClient } from './worker-record-client.ts'
import {
  WORKER_RECORD_READ_POLL_MS,
  type WorkerRecordReadKind,
} from './worker-record-read-request.ts'

type PendingRead = {
  record_id: string
  kind: WorkerRecordReadKind
  reference: string
  project: string | null
}

function claim(runId: string): PendingRead | null {
  return writeTransaction(() => {
    const row = db()
      .query(
        `SELECT record_id,kind,reference,project FROM worker_record_read_request
         WHERE run_record_id=? AND status='requested' AND claimed_at IS NULL
         ORDER BY requested_at,record_id LIMIT 1`,
      )
      .get(runId) as PendingRead | null
    if (!row) return null
    const changed = db()
      .query(
        `UPDATE worker_record_read_request SET claimed_at=?
         WHERE record_id=? AND claimed_at IS NULL`,
      )
      .run(nowIso(), row.record_id)
    return changed.changes === 1 ? row : null
  })
}

async function read(
  request: PendingRead,
  runId: string,
  token: string,
  client?: WorkerRecordClient,
): Promise<unknown> {
  const dependencies = client ? { client } : {}
  if (request.kind === 'task')
    return readWorkerTask(runId, token, request.reference, request.project ?? undefined, dependencies)
  if (request.kind === 'task-document')
    return readWorkerTaskDocument(
      runId,
      token,
      request.reference,
      request.project ?? undefined,
      dependencies,
    )
  return readWorkerWorkflowText(
    runId,
    token,
    request.reference,
    request.project ?? undefined,
    dependencies,
  )
}

export async function processWorkerRecordReadRequest(
  runId: string,
  token: string,
  client?: WorkerRecordClient,
): Promise<boolean> {
  const request = claim(runId)
  if (!request) return false
  try {
    const result = JSON.stringify(await read(request, runId, token, client))
    db()
      .query(
        `UPDATE worker_record_read_request
         SET status='result',result=?,finished_at=? WHERE record_id=? AND status='requested'`,
      )
      .run(result, nowIso(), request.record_id)
  } catch (error) {
    const refusal = error instanceof Error ? error.message : String(error)
    db()
      .query(
        `UPDATE worker_record_read_request
         SET status='refused',refusal=?,finished_at=? WHERE record_id=? AND status='requested'`,
      )
      .run(refusal, nowIso(), request.record_id)
  }
  return true
}

export type WorkerRecordReadBroker = { close(): Promise<void> }

export function startWorkerRecordReadBroker(
  runId: string,
  token: string,
  client?: WorkerRecordClient,
): WorkerRecordReadBroker {
  let closed = false
  let active: Promise<boolean> | null = null
  const poll = () => {
    if (closed || active) return
    let operation: Promise<boolean>
    try {
      operation = processWorkerRecordReadRequest(runId, token, client)
    } catch (error) {
      if (!isDatabaseLocked(error)) {
        clearInterval(timer)
        appendRunEvent(runId, {
          ts: nowIso(),
          type: 'text',
          text: `worker record read broker stopped after claim failure: ${String(error)}`,
        })
      }
      return
    }
    active = operation
    void operation.finally(() => {
      if (active === operation) active = null
    })
  }
  const timer = setInterval(poll, WORKER_RECORD_READ_POLL_MS)
  poll()
  return {
    async close() {
      closed = true
      clearInterval(timer)
      if (active) await active
      writeTransaction(() => {
        db().query('DELETE FROM worker_record_read_request WHERE run_record_id=?').run(runId)
      })
    },
  }
}
