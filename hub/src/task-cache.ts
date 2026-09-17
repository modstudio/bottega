import type { Database } from 'bun:sqlite'
import { db, writeTransaction } from './db.ts'
import { hostedTaskChanges, type TaskFetch } from './task-client.ts'

const CURSOR_KEY = 'collect.hosted-tasks.cursor'
type HostedChanges = Awaited<ReturnType<typeof hostedTaskChanges>>

function localId(conn: Database, table: string, recordId: string, legacy: number | null) {
  const byRecord = conn
    .query<{ id: number }, [string]>(`SELECT id FROM ${table} WHERE record_id=?`)
    .get(recordId)
  if (byRecord) return byRecord.id
  if (legacy !== null) {
    const byLegacy = conn
      .query<{ id: number }, [number]>(`SELECT id FROM ${table} WHERE id=?`)
      .get(legacy)
    if (byLegacy) return byLegacy.id
  }
  return null
}

export function applyHostedTask(conn: Database, row: HostedChanges['tasks'][number]) {
  if (row.deleted_at) {
    conn.query(`DELETE FROM task WHERE key=?`).run(row.key)
    return
  }
  conn
    .query(`INSERT INTO task
      (record_id,key,project,title,status,status_category,parent_key,body,assignee,opened_at,
       closed_at,updated_at,source,first_seen,last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      record_id=excluded.record_id,project=excluded.project,title=excluded.title,
      status=excluded.status,status_category=excluded.status_category,parent_key=excluded.parent_key,
      body=excluded.body,assignee=excluded.assignee,opened_at=excluded.opened_at,
      closed_at=excluded.closed_at,updated_at=excluded.updated_at,source=excluded.source,
      first_seen=excluded.first_seen,last_seen=excluded.last_seen`)
    .run(
      row.id,
      row.key,
      row.project,
      row.title,
      row.status,
      row.status_category,
      row.parent_key,
      row.body,
      row.assignee,
      row.opened_at,
      row.closed_at,
      row.updated_at,
      row.source,
      row.first_seen,
      row.last_seen,
    )
}

function applyComment(conn: Database, row: HostedChanges['comments'][number]) {
  const id = localId(conn, 'task_comment', row.id, row.legacy_local_id)
  if (row.deleted_at) {
    if (id) conn.query(`DELETE FROM task_comment WHERE id=?`).run(id)
  } else if (id) {
    conn
      .query(`UPDATE task_comment SET record_id=?,task_key=?,body=?,created_at=? WHERE id=?`)
      .run(row.id, row.task_key, row.body, row.created_at, id)
  } else {
    conn
      .query(`INSERT INTO task_comment (record_id,task_key,body,created_at) VALUES (?,?,?,?)`)
      .run(row.id, row.task_key, row.body, row.created_at)
  }
}

function applyDocument(conn: Database, row: HostedChanges['documents'][number]) {
  const id = localId(conn, 'task_document', row.id, row.legacy_local_id)
  if (row.deleted_at) {
    if (id) conn.query(`DELETE FROM task_document WHERE id=?`).run(id)
  } else if (id) {
    conn
      .query(
        `UPDATE task_document SET record_id=?,task_key=?,role=?,title=?,body=?,version=?,created_at=?,updated_at=? WHERE id=?`,
      )
      .run(
        row.id,
        row.task_key,
        row.role,
        row.title,
        row.body,
        row.version,
        row.created_at,
        row.updated_at,
        id,
      )
  } else {
    conn
      .query(
        `INSERT INTO task_document (record_id,task_key,role,title,body,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.task_key,
        row.role,
        row.title,
        row.body,
        row.version,
        row.created_at,
        row.updated_at,
      )
  }
}

function applyStatusEvent(conn: Database, row: HostedChanges['statusEvents'][number]) {
  const id = localId(conn, 'task_status_event', row.id, row.legacy_local_id)
  if (row.deleted_at) {
    if (id) conn.query(`DELETE FROM task_status_event WHERE id=?`).run(id)
  } else if (id) {
    conn
      .query(
        `UPDATE task_status_event SET record_id=?,task_key=?,at=?,from_status=?,to_status=? WHERE id=?`,
      )
      .run(row.id, row.task_key, row.at, row.from_status, row.to_status, id)
  } else {
    conn
      .query(
        `INSERT OR IGNORE INTO task_status_event (record_id,task_key,at,from_status,to_status) VALUES (?,?,?,?,?)`,
      )
      .run(row.id, row.task_key, row.at, row.from_status, row.to_status)
  }
}

export function applyHostedTaskChanges(changes: HostedChanges) {
  writeTransaction((conn) => {
    changes.tasks.forEach((row) => {
      applyHostedTask(conn, row)
    })
    changes.comments.forEach((row) => {
      applyComment(conn, row)
    })
    changes.documents.forEach((row) => {
      applyDocument(conn, row)
    })
    changes.statusEvents.forEach((row) => {
      applyStatusEvent(conn, row)
    })
    conn
      .query(
        `INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(CURSOR_KEY, changes.cursor)
  })
}

export async function pullHostedTasks(
  options: { baseUrl?: string; token?: string | null; fetch?: TaskFetch } = {},
) {
  const cursor =
    db().query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`).get(CURSOR_KEY)
      ?.value ?? null
  const changes = await hostedTaskChanges(cursor, options)
  applyHostedTaskChanges(changes)
  return {
    tasks: changes.tasks.length,
    comments: changes.comments.length,
    documents: changes.documents.length,
    statusEvents: changes.statusEvents.length,
    cursor: changes.cursor,
  }
}
