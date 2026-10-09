import type { Database } from 'bun:sqlite'
import { db, writeTransaction } from './db.ts'
import { persistInstallBinding } from './install-binding.ts'
import { projects } from './projects.ts'
import { hostedTaskChanges, hostedTaskIdentity, type TaskFetch } from './task-client.ts'
import { formatTaskDocumentLabel } from './task-document-label.ts'
import { taskIdentityRelationships, taskRecordIdFor } from './task-identity.ts'
import { type RegisteredTaskSpace, taskPullSpaces } from './task-project-space.ts'

const CURSOR_KEY = 'collect.hosted-tasks.cursor'
type HostedChanges = Awaited<ReturnType<typeof hostedTaskChanges>>
export type HostedTaskChangeTable =
  | 'hub_task'
  | 'hub_task_comment'
  | 'hub_task_document'
  | 'hub_task_status_event'

export function reconcileParentRecordIds(conn: Database) {
  for (const relationship of taskIdentityRelationships) {
    if (relationship.table !== 'task') continue
    const unresolved = conn
      .query<{ key: string; project: string }, []>(
        `SELECT DISTINCT ${relationship.keyColumn} key, project FROM ${relationship.table}
         WHERE ${relationship.keyColumn} IS NOT NULL AND ${relationship.recordColumn} IS NULL`,
      )
      .all()
    const update = conn.query(
      `UPDATE ${relationship.table} SET ${relationship.recordColumn}=?
       WHERE ${relationship.keyColumn}=? AND project=? AND ${relationship.recordColumn} IS NULL`,
    )
    for (const { key, project } of unresolved) {
      const recordId = taskRecordIdFor(conn, key, project)
      if (recordId) update.run(recordId, key, project)
    }
  }
}

export function applyHostedTask(conn: Database, row: HostedChanges['tasks'][number]) {
  persistInstallBinding(conn)
  if (row.deleted_at) {
    conn.query(`DELETE FROM task WHERE record_id=?`).run(row.id)
    return
  }
  const parentRecordId = row.parent_key ? taskRecordIdFor(conn, row.parent_key, row.project) : null
  conn
    .query(`INSERT INTO task
      (record_id,key,project,title,status,status_category,parent_key,parent_record_id,body,assignee,opened_at,
       closed_at,updated_at,source,first_seen,last_seen,next_document_number)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET
      key=excluded.key,project=excluded.project,title=excluded.title,
      status=excluded.status,status_category=excluded.status_category,parent_key=excluded.parent_key,
      parent_record_id=excluded.parent_record_id,
      body=excluded.body,assignee=excluded.assignee,opened_at=excluded.opened_at,
      closed_at=excluded.closed_at,updated_at=excluded.updated_at,source=excluded.source,
      first_seen=excluded.first_seen,last_seen=excluded.last_seen,
      next_document_number=MAX(task.next_document_number,excluded.next_document_number)`)
    .run(
      row.id,
      row.key,
      row.project,
      row.title,
      row.status,
      row.status_category,
      row.parent_key,
      parentRecordId,
      row.body,
      row.assignee,
      row.opened_at,
      row.closed_at,
      row.updated_at,
      row.source,
      row.first_seen,
      row.last_seen,
      row.next_document_number,
    )
}

function applyComment(conn: Database, row: HostedChanges['comments'][number]) {
  const taskRecordId = taskRecordIdFor(conn, row.task_key, row.project_name)
  if (row.deleted_at) {
    conn.query(`DELETE FROM task_comment WHERE record_id=?`).run(row.id)
    return
  }
  const updated = conn
    .query(
      `UPDATE task_comment SET task_key=?,task_record_id=?,body=?,created_at=? WHERE record_id=?`,
    )
    .run(row.task_key, taskRecordId, row.body, row.created_at, row.id)
  if (!updated.changes)
    conn
      .query(
        `INSERT INTO task_comment (record_id,task_key,task_record_id,body,created_at) VALUES (?,?,?,?,?)`,
      )
      .run(row.id, row.task_key, taskRecordId, row.body, row.created_at)
}

function applyDocument(conn: Database, row: HostedChanges['documents'][number]) {
  if (row.deleted_at) {
    conn.query(`DELETE FROM task_document WHERE record_id=?`).run(row.id)
    return
  }
  const taskRecordId = taskRecordIdFor(conn, row.task_key, row.project_name)
  if (!taskRecordId) throw new Error(`no task ${row.task_key} in project ${row.project_name}`)
  if (row.number === null)
    throw new Error(`live task document ${row.id} for task ${row.task_key} has no number`)
  const collision = conn
    .query<{ record_id: string }, [string, number, string]>(
      `SELECT record_id FROM task_document WHERE task_record_id=? AND number=? AND record_id<>?`,
    )
    .get(taskRecordId, row.number, row.id)
  if (collision) {
    throw new Error(
      `task document number collision: ${formatTaskDocumentLabel(row.task_key, row.number)} belongs to UUID ${collision.record_id}, not incoming UUID ${row.id}; run \`hub task doc list ${row.task_key}\``,
    )
  }
  conn
    .query(
      `INSERT INTO task_document
          (record_id,task_key,task_record_id,number,role,title,body,version,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET
          task_key=excluded.task_key,task_record_id=excluded.task_record_id,number=excluded.number,
          role=excluded.role,title=excluded.title,body=excluded.body,version=excluded.version,
          created_at=excluded.created_at,updated_at=excluded.updated_at`,
    )
    .run(
      row.id,
      row.task_key,
      taskRecordId,
      row.number,
      row.role,
      row.title,
      row.body,
      row.version,
      row.created_at,
      row.updated_at,
    )
  conn
    .query(`UPDATE task SET next_document_number=MAX(next_document_number,?) WHERE record_id=?`)
    .run(row.number + 1, taskRecordId)
}

function applyStatusEvent(conn: Database, row: HostedChanges['statusEvents'][number]) {
  const taskRecordId = taskRecordIdFor(conn, row.task_key, row.project_name)
  if (row.deleted_at) {
    conn.query(`DELETE FROM task_status_event WHERE record_id=?`).run(row.id)
    return
  }
  const updated = conn
    .query(
      `UPDATE task_status_event SET task_key=?,task_record_id=?,at=?,from_status=?,to_status=? WHERE record_id=?`,
    )
    .run(row.task_key, taskRecordId, row.at, row.from_status, row.to_status, row.id)
  if (!updated.changes)
    conn
      .query(
        `INSERT OR IGNORE INTO task_status_event (record_id,task_key,task_record_id,at,from_status,to_status) VALUES (?,?,?,?,?,?)`,
      )
      .run(row.id, row.task_key, taskRecordId, row.at, row.from_status, row.to_status)
}

export function applyHostedTaskRows(conn: Database, changes: HostedChanges) {
  changes.tasks.forEach((row) => {
    applyHostedTask(conn, row)
  })
  reconcileParentRecordIds(conn)
  changes.comments.forEach((row) => {
    applyComment(conn, row)
  })
  changes.documents.forEach((row) => {
    applyDocument(conn, row)
  })
  changes.statusEvents.forEach((row) => {
    applyStatusEvent(conn, row)
  })
}

export function applyHostedChangeUpsert(
  conn: Database,
  table: HostedTaskChangeTable,
  row:
    | HostedChanges['tasks'][number]
    | HostedChanges['comments'][number]
    | HostedChanges['documents'][number]
    | HostedChanges['statusEvents'][number],
) {
  if (table === 'hub_task') {
    applyHostedTask(conn, row as HostedChanges['tasks'][number])
    return
  }
  if (table === 'hub_task_comment') {
    applyComment(conn, row as HostedChanges['comments'][number])
    return
  }
  if (table === 'hub_task_document') {
    applyDocument(conn, row as HostedChanges['documents'][number])
    return
  }
  applyStatusEvent(conn, row as HostedChanges['statusEvents'][number])
}

const MACHINE_TABLE = {
  hub_task: 'task',
  hub_task_comment: 'task_comment',
  hub_task_document: 'task_document',
  hub_task_status_event: 'task_status_event',
} as const

export function deleteHostedChangeRow(conn: Database, table: HostedTaskChangeTable, id: string) {
  conn.query(`DELETE FROM ${MACHINE_TABLE[table]} WHERE record_id=?`).run(id)
}

export function hostedChangeMachineRow(
  conn: Database,
  table: HostedTaskChangeTable,
  id: string,
): Record<string, unknown> | null {
  return (
    conn
      .query<Record<string, unknown>, [string]>(
        `SELECT * FROM ${MACHINE_TABLE[table]} WHERE record_id=?`,
      )
      .get(id) ?? null
  )
}

export function hostedChangeRowProject(
  conn: Database,
  table: HostedTaskChangeTable,
  id: string,
): string | null {
  if (table === 'hub_task')
    return (
      conn
        .query<{ project: string }, [string]>(`SELECT project FROM task WHERE record_id=?`)
        .get(id)?.project ?? null
    )
  const child = conn
    .query<{ task_record_id: string | null }, [string]>(
      `SELECT task_record_id FROM ${MACHINE_TABLE[table]} WHERE record_id=?`,
    )
    .get(id)
  if (!child?.task_record_id) return null
  return (
    conn
      .query<{ project: string }, [string]>(`SELECT project FROM task WHERE record_id=?`)
      .get(child.task_record_id)?.project ?? null
  )
}

export function applyHostedTaskChanges(
  changes: HostedChanges,
  cursorKey = CURSOR_KEY,
  clearLegacyCursor = false,
) {
  writeTransaction((conn) => {
    applyHostedTaskRows(conn, changes)
    conn
      .query(
        `INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(cursorKey, changes.cursor)
    if (clearLegacyCursor) conn.query(`DELETE FROM setting WHERE key=?`).run(CURSOR_KEY)
  })
}

const cursorKeyFor = (spaceId: string) => `${CURSOR_KEY}.${spaceId}`

function pullCursor(spaceId: string, activeSpaceId: string) {
  const cursor = db()
    .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`)
    .get(cursorKeyFor(spaceId))?.value
  if (cursor !== undefined) return { cursor, fromLegacy: false }
  if (spaceId !== activeSpaceId) return { cursor: null, fromLegacy: false }
  const legacy = db()
    .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`)
    .get(CURSOR_KEY)?.value
  return { cursor: legacy ?? null, fromLegacy: legacy !== undefined }
}

export async function pullHostedTasks(
  options: {
    baseUrl?: string
    token?: string | null
    fetch?: TaskFetch
    registeredProjects?: readonly RegisteredTaskSpace[]
  } = {},
) {
  const requestOptions = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  const identity = await hostedTaskIdentity(requestOptions)
  const spaces = taskPullSpaces(options.registeredProjects ?? projects(), identity)
  const totals = { tasks: 0, comments: 0, documents: 0, statusEvents: 0 }
  let activeCursor = ''
  const failures: string[] = []
  for (const spaceId of spaces) {
    const cursorKey = cursorKeyFor(spaceId)
    const { cursor, fromLegacy } = pullCursor(spaceId, identity.activeSpaceId)
    try {
      const changes = await hostedTaskChanges(cursor, { ...requestOptions, recordSpace: spaceId })
      applyHostedTaskChanges(changes, cursorKey, fromLegacy)
      totals.tasks += changes.tasks.length
      totals.comments += changes.comments.length
      totals.documents += changes.documents.length
      totals.statusEvents += changes.statusEvents.length
      if (spaceId === identity.activeSpaceId) activeCursor = changes.cursor
    } catch (cause) {
      failures.push(`${spaceId}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (failures.length) throw new Error(`hosted task pulls failed: ${failures.join('; ')}`)
  return {
    ...totals,
    cursor: activeCursor,
  }
}
