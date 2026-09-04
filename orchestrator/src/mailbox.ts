/** Durable, non-authoritative messages attached to a run conversation. */
import { db, nowIso, sessionId } from './db.ts'

export type RunMessage = {
  id: number
  direction: 'to_worker' | 'from_worker'
  root_run_id: number
  run_id: number
  sender_session: string | null
  body: string
  created_at: string
  read_at: string | null
  delivery: 'architect_cli' | 'worker_tool'
}

type RunIdentity = {
  id: number
  root_id: number
  status: string
  vendor_session: string | null
}

function identity(id: number): RunIdentity | null {
  return db().query(
    `SELECT id, COALESCE(parent_run_id, id) AS root_id, status, vendor_session
       FROM run WHERE id = ?`,
  ).get(id) as RunIdentity | null
}

function bodyOf(body: string): string {
  if (!body.trim()) throw new Error('message body is empty')
  return body
}

/** Queue architect context against the conversation's currently running turn. */
export function tellRun(id: number, body: string): RunMessage {
  const requested = identity(id)
  if (!requested) throw new Error(`no run ${id}`)
  const active = db().query(
    `SELECT id, COALESCE(parent_run_id, id) AS root_id, status, vendor_session
       FROM run
      WHERE (id = ? OR parent_run_id = ?) AND status = 'running'
      ORDER BY turn DESC, id DESC LIMIT 1`,
  ).get(requested.root_id, requested.root_id) as RunIdentity | null
  if (!active) {
    throw new Error(`run ${requested.root_id} has no running turn — no message was queued`)
  }
  return db().query(
    `INSERT INTO run_message
       (direction, root_run_id, run_id, sender_session, body, created_at, delivery)
     VALUES ('to_worker', ?, ?, ?, ?, ?, 'architect_cli') RETURNING *`,
  ).get(active.root_id, active.id, sessionId(), bodyOf(body), nowIso()) as RunMessage
}

/** Record an outbound worker message without changing the run's status. */
export function messageArchitect(runId: number, body: string): RunMessage {
  const run = identity(runId)
  if (!run) throw new Error(`no run ${runId}`)
  if (run.status !== 'running') {
    throw new Error(`run ${runId} is ${run.status}, not running`)
  }
  return db().query(
    `INSERT INTO run_message
       (direction, root_run_id, run_id, sender_session, body, created_at, read_at, delivery)
     VALUES ('from_worker', ?, ?, ?, ?, ?, NULL, 'worker_tool') RETURNING *`,
  ).get(run.root_id, run.id, run.vendor_session, bodyOf(body), nowIso()) as RunMessage
}

/** Read and receipt all context queued for this worker's conversation. */
export function checkMessages(runId: number): RunMessage[] {
  const run = identity(runId)
  if (!run) throw new Error(`no run ${runId}`)
  if (run.status !== 'running') {
    throw new Error(`run ${runId} is ${run.status}, not running`)
  }
  return db().transaction(() => {
    const rows = db().query(
      `SELECT * FROM run_message
        WHERE root_run_id = ? AND direction = 'to_worker' AND read_at IS NULL
        ORDER BY id`,
    ).all(run.root_id) as RunMessage[]
    if (!rows.length) return []
    const readAt = nowIso()
    const ids = rows.map(() => '?').join(',')
    db().query(`UPDATE run_message SET read_at = ? WHERE id IN (${ids})`).run(
      readAt, ...rows.map((row) => row.id),
    )
    return rows.map((row) => ({ ...row, read_at: readAt }))
  })()
}

export function messagesForRun(id: number): RunMessage[] {
  const run = identity(id)
  if (!run) return []
  return db().query(
    'SELECT * FROM run_message WHERE root_run_id = ? ORDER BY id',
  ).all(run.root_id) as RunMessage[]
}

/** Viewing the run is the architect-side receipt for outbound messages. */
export function readMessagesForArchitect(id: number): RunMessage[] {
  const run = identity(id)
  if (!run) return []
  return db().transaction(() => {
    const readAt = nowIso()
    db().query(
      `UPDATE run_message SET read_at = ?
        WHERE root_run_id = ? AND direction = 'from_worker' AND read_at IS NULL`,
    ).run(readAt, run.root_id)
    return messagesForRun(id)
  })()
}
