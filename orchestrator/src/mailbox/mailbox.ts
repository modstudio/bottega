/** Durable, non-authoritative messages attached to a run conversation. */

import { newRecordId } from '../../../shared/record-id.ts'
import { db, storeWritesRefused, writableDb, writeTransaction } from '../database/db.ts'
import { adoptRunMutation, auditRunMutation, authorizeRunMutation } from '../run/run-authority.ts'
import type { TransportName } from '../transport/transport.ts'

const nowIso = (): string => new Date(Date.now()).toISOString()

export type RunMessage = {
  record_id: string
  number: number
  direction: 'to_worker' | 'from_worker'
  root_run_record_id: string
  run_record_id: string
  sender_session: string | null
  body: string
  created_at: string
  read_at: string | null
  read_by: string | null
  delivery: 'architect_cli' | 'worker_tool'
}

type RunIdentity = {
  record_id: string
  root_record_id: string
  status: string
  vendor_session: string | null
  transport: TransportName | null
}

function identity(id: string): RunIdentity | null {
  return db()
    .query(
      `SELECT record_id, COALESCE(parent_run_record_id,record_id) AS root_record_id, status, vendor_session, transport
       FROM run WHERE record_id = ?`,
    )
    .get(id) as RunIdentity | null
}

function bodyOf(body: string): string {
  if (!body.trim()) throw new Error('message body is empty')
  return body
}

/** Queue architect context against the conversation's currently running turn. */
export function tellRun(
  id: string,
  body: string,
): RunMessage & { transport: TransportName | null } {
  writableDb()
  let authority = authorizeRunMutation(id, 'tell')
  const requested = identity(id)
  if (!requested) throw new Error(`no run ${id}`)
  const active = db()
    .query(
      `SELECT record_id, COALESCE(parent_run_record_id,record_id) AS root_record_id, status, vendor_session, transport
       FROM run
      WHERE (record_id = ? OR parent_run_record_id = ?) AND status = 'running'
      ORDER BY turn DESC, number DESC LIMIT 1`,
    )
    .get(requested.root_record_id, requested.root_record_id) as RunIdentity | null
  if (!active) {
    throw new Error(`run ${requested.root_record_id} has no running turn — no message was queued`)
  }
  const messageBody = bodyOf(body)
  return writeTransaction(() => {
    authority = adoptRunMutation(authority, 'tell')
    const messageRecordId = newRecordId()
    db()
      .query(
        `INSERT INTO run_message
         (record_id, direction, root_run_record_id, run_record_id, sender_session, body, created_at, delivery)
       VALUES (?, 'to_worker', ?, ?, ?, ?, ?, 'architect_cli')`,
      )
      .run(
        messageRecordId,
        active.root_record_id,
        active.record_id,
        authority.actor,
        messageBody,
        nowIso(),
      )
    const message = db()
      .query('SELECT * FROM run_message WHERE record_id=?')
      .get(messageRecordId) as RunMessage
    auditRunMutation(authority, 'tell')
    return { ...message, transport: active.transport }
  })
}

/** Record an outbound worker message without changing the run's status. */
export function messageArchitect(runId: string, body: string): RunMessage {
  writableDb()
  const run = identity(runId)
  if (!run) throw new Error(`no run ${runId}`)
  if (run.status !== 'running') {
    throw new Error(`run ${runId} is ${run.status}, not running`)
  }
  const messageRecordId = newRecordId()
  db()
    .query(
      `INSERT INTO run_message
       (record_id, direction, root_run_record_id, run_record_id, sender_session, body, created_at, read_at, delivery)
     VALUES (?, 'from_worker', ?, ?, ?, ?, ?, NULL, 'worker_tool')`,
    )
    .run(
      messageRecordId,
      run.root_record_id,
      run.record_id,
      run.vendor_session,
      bodyOf(body),
      nowIso(),
    )
  return db()
    .query('SELECT * FROM run_message WHERE record_id=?')
    .get(messageRecordId) as RunMessage
}

/** Read and receipt all context queued for this worker's conversation. */
export function checkMessages(runId: string): RunMessage[] {
  const run = identity(runId)
  if (!run) throw new Error(`no run ${runId}`)
  if (run.status !== 'running') {
    throw new Error(`run ${runId} is ${run.status}, not running`)
  }
  return writeTransaction(() => {
    const rows = db()
      .query(
        `SELECT * FROM run_message
        WHERE root_run_record_id = ? AND direction = 'to_worker' AND read_at IS NULL
        ORDER BY created_at, record_id`,
      )
      .all(run.root_record_id) as RunMessage[]
    if (!rows.length) return []
    if (storeWritesRefused()) return rows
    const readAt = nowIso()
    const ids = rows.map(() => '?').join(',')
    db()
      .query(`UPDATE run_message SET read_at = ?, read_by = ? WHERE record_id IN (${ids})`)
      .run(readAt, run.vendor_session, ...rows.map((row) => row.record_id))
    return rows.map((row) => ({ ...row, read_at: readAt, read_by: run.vendor_session }))
  })
}

/** Inspect queued worker context without claiming that a turn consumed it. */
export function unreadWorkerMessages(runId: string): RunMessage[] {
  const run = identity(runId)
  if (!run) throw new Error(`no run ${runId}`)
  return db()
    .query(
      `SELECT * FROM run_message
      WHERE root_run_record_id = ? AND direction = 'to_worker' AND read_at IS NULL
      ORDER BY created_at, record_id`,
    )
    .all(run.root_record_id) as RunMessage[]
}

/** Receipt only messages already placed into a prompt submitted to the worker. */
export function receiptWorkerMessages(runId: string, ids: string[]): void {
  if (!ids.length || storeWritesRefused()) return
  const run = identity(runId)
  if (run?.status !== 'running') return
  const slots = ids.map(() => '?').join(',')
  db()
    .query(
      `UPDATE run_message SET read_at=?, read_by=?
      WHERE root_run_record_id=? AND direction='to_worker' AND read_at IS NULL AND record_id IN (${slots})`,
    )
    .run(nowIso(), run.vendor_session, run.root_record_id, ...ids)
}

export function messagesForRun(id: string): RunMessage[] {
  const run = identity(id)
  if (!run) return []
  return db()
    .query('SELECT * FROM run_message WHERE root_run_record_id = ? ORDER BY created_at, record_id')
    .all(run.root_record_id) as RunMessage[]
}

/** Receipt unread outbound worker messages: authorize the caller, adopt an unowned root, then set read_at/read_by. */
export function receiptMessagesForArchitect(id: string): RunMessage[] {
  writableDb()
  let authority = authorizeRunMutation(id, 'receipt')
  const run = identity(id)
  if (!run) return []
  return writeTransaction(() => {
    authority = adoptRunMutation(authority, 'receipt')
    const readAt = nowIso()
    db()
      .query(
        `UPDATE run_message SET read_at = ?, read_by = ?
        WHERE root_run_record_id = ? AND direction = 'from_worker' AND read_at IS NULL`,
      )
      .run(readAt, authority.actor, run.root_record_id)
    return messagesForRun(id)
  })
}
