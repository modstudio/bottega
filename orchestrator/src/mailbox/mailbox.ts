/** Durable, non-authoritative messages attached to a run conversation. */

import { clock } from '../clock.ts'
import { db, linkedWorktreeReadOnly, writableDb, writeTransaction } from '../db.ts'
import { adoptRunMutation, auditRunMutation, authorizeRunMutation } from '../run/run-authority.ts'

const nowIso = (): string => new Date(clock().now()).toISOString()

export type RunMessage = {
  id: number
  direction: 'to_worker' | 'from_worker'
  root_run_id: number
  run_id: number
  sender_session: string | null
  body: string
  created_at: string
  read_at: string | null
  read_by: string | null
  delivery: 'architect_cli' | 'worker_tool'
}

type RunIdentity = {
  id: number
  root_id: number
  status: string
  vendor_session: string | null
}

function identity(id: number): RunIdentity | null {
  return db()
    .query(
      `SELECT id, COALESCE(parent_run_id, id) AS root_id, status, vendor_session
       FROM run WHERE id = ?`,
    )
    .get(id) as RunIdentity | null
}

function bodyOf(body: string): string {
  if (!body.trim()) throw new Error('message body is empty')
  return body
}

/** Queue architect context against the conversation's currently running turn. */
export function tellRun(id: number, body: string): RunMessage {
  writableDb()
  let authority = authorizeRunMutation(id, 'tell')
  const requested = identity(id)
  if (!requested) throw new Error(`no run ${id}`)
  const active = db()
    .query(
      `SELECT id, COALESCE(parent_run_id, id) AS root_id, status, vendor_session
       FROM run
      WHERE (id = ? OR parent_run_id = ?) AND status = 'running'
      ORDER BY turn DESC, id DESC LIMIT 1`,
    )
    .get(requested.root_id, requested.root_id) as RunIdentity | null
  if (!active) {
    throw new Error(`run ${requested.root_id} has no running turn — no message was queued`)
  }
  const messageBody = bodyOf(body)
  return writeTransaction(() => {
    authority = adoptRunMutation(authority, 'tell')
    const message = db()
      .query(
        `INSERT INTO run_message
         (direction, root_run_id, run_id, sender_session, body, created_at, delivery)
       VALUES ('to_worker', ?, ?, ?, ?, ?, 'architect_cli') RETURNING *`,
      )
      .get(active.root_id, active.id, authority.actor, messageBody, nowIso()) as RunMessage
    auditRunMutation(authority, 'tell')
    return message
  })
}

/** Record an outbound worker message without changing the run's status. */
export function messageArchitect(runId: number, body: string): RunMessage {
  writableDb()
  const run = identity(runId)
  if (!run) throw new Error(`no run ${runId}`)
  if (run.status !== 'running') {
    throw new Error(`run ${runId} is ${run.status}, not running`)
  }
  return db()
    .query(
      `INSERT INTO run_message
       (direction, root_run_id, run_id, sender_session, body, created_at, read_at, delivery)
     VALUES ('from_worker', ?, ?, ?, ?, ?, NULL, 'worker_tool') RETURNING *`,
    )
    .get(run.root_id, run.id, run.vendor_session, bodyOf(body), nowIso()) as RunMessage
}

/** Read and receipt all context queued for this worker's conversation. */
export function checkMessages(runId: number): RunMessage[] {
  const run = identity(runId)
  if (!run) throw new Error(`no run ${runId}`)
  if (run.status !== 'running') {
    throw new Error(`run ${runId} is ${run.status}, not running`)
  }
  return writeTransaction(() => {
    const rows = db()
      .query(
        `SELECT * FROM run_message
        WHERE root_run_id = ? AND direction = 'to_worker' AND read_at IS NULL
        ORDER BY id`,
      )
      .all(run.root_id) as RunMessage[]
    if (!rows.length) return []
    if (linkedWorktreeReadOnly) return rows
    const readAt = nowIso()
    const ids = rows.map(() => '?').join(',')
    db()
      .query(`UPDATE run_message SET read_at = ?, read_by = ? WHERE id IN (${ids})`)
      .run(readAt, run.vendor_session, ...rows.map((row) => row.id))
    return rows.map((row) => ({ ...row, read_at: readAt, read_by: run.vendor_session }))
  })
}

/** Inspect queued worker context without claiming that a turn consumed it. */
export function unreadWorkerMessages(runId: number): RunMessage[] {
  const run = identity(runId)
  if (!run) throw new Error(`no run ${runId}`)
  return db()
    .query(
      `SELECT * FROM run_message
      WHERE root_run_id = ? AND direction = 'to_worker' AND read_at IS NULL
      ORDER BY id`,
    )
    .all(run.root_id) as RunMessage[]
}

/** Receipt only messages already placed into a prompt submitted to the worker. */
export function receiptWorkerMessages(runId: number, ids: number[]): void {
  if (!ids.length || linkedWorktreeReadOnly) return
  const run = identity(runId)
  if (!run || run.status !== 'running') return
  const slots = ids.map(() => '?').join(',')
  db()
    .query(
      `UPDATE run_message SET read_at=?, read_by=?
      WHERE root_run_id=? AND direction='to_worker' AND read_at IS NULL AND id IN (${slots})`,
    )
    .run(nowIso(), run.vendor_session, run.root_id, ...ids)
}

export function messagesForRun(id: number): RunMessage[] {
  const run = identity(id)
  if (!run) return []
  return db()
    .query('SELECT * FROM run_message WHERE root_run_id = ? ORDER BY id')
    .all(run.root_id) as RunMessage[]
}

/** Receipt unread outbound worker messages: authorize the caller, adopt an unowned root, then set read_at/read_by. */
export function receiptMessagesForArchitect(id: number): RunMessage[] {
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
        WHERE root_run_id = ? AND direction = 'from_worker' AND read_at IS NULL`,
      )
      .run(readAt, authority.actor, run.root_id)
    return messagesForRun(id)
  })
}
