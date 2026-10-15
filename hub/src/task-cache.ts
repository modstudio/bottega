import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { persistInstallBinding } from './install-binding.ts'
import { adoptPendingHostedRow } from './outbox.ts'
import { HOSTED_MACHINE_TABLES, reconcilePulledRow } from './pending-hosted-edit.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import { HOSTED_STATUS_EVENT_TABLE } from './push-contract.ts'
import { isSameStatusEvent, statusEventIdentity } from './status-event-identity.ts'
import type { hostedTaskChanges } from './task-client.ts'
import { formatTaskDocumentLabel } from './task-document-label.ts'
import { taskIdentityRelationships, taskRecordIdFor } from './task-identity.ts'

type HostedChanges = Awaited<ReturnType<typeof hostedTaskChanges>>
type HostedChangeRow =
  | HostedChanges['tasks'][number]
  | HostedChanges['comments'][number]
  | HostedChanges['documents'][number]
  | HostedChanges['statusEvents'][number]

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
  const current = conn
    .query<{ source: string; opened_at: string | null; updated_at: string }, [string]>(
      'SELECT source,opened_at,updated_at FROM task WHERE record_id=?',
    )
    .get(row.id)
  const preserveGitDate = (incoming: string | null, stored: string | null) =>
    current?.source === 'git' &&
    incoming !== null &&
    stored !== null &&
    new Date(incoming).getTime() === new Date(stored).getTime()
      ? stored
      : incoming
  conn
    .query(`INSERT INTO task
      (record_id,key,project,project_record_id,title,status,status_category,parent_key,parent_record_id,body,assignee,opened_at,
       closed_at,updated_at,source,first_seen,last_seen,next_document_number)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET
      key=excluded.key,project=excluded.project,
      project_record_id=COALESCE(excluded.project_record_id,task.project_record_id),title=excluded.title,
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
      row.projectId ?? projectRecordIdFor(row.project),
      row.title,
      row.status,
      row.status_category,
      row.parent_key,
      parentRecordId,
      row.body,
      row.assignee,
      preserveGitDate(row.opened_at, current?.opened_at ?? null),
      row.closed_at,
      preserveGitDate(row.updated_at, current?.updated_at ?? null),
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
      `task document number collision: ${formatTaskDocumentLabel(row.task_key, row.number)} belongs to UUID ${collision.record_id}, not incoming UUID ${row.id}; run \`${PLATFORM_SLUG} task doc list ${row.task_key}\``,
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

type StatusEventMatchRow = {
  record_id: string
  task_record_id: string | null
  task_key: string
  to_status: string
  at: string
}

function matchingStatusEvent(
  conn: Database,
  row: HostedChanges['statusEvents'][number],
  taskRecordId: string | null,
): { record_id: string } | null {
  const candidates = taskRecordId
    ? conn
        .query<StatusEventMatchRow, [string, string, string]>(
          `SELECT record_id,task_record_id,task_key,to_status,at FROM task_status_event
           WHERE record_id<>? AND (task_record_id=? OR (task_record_id IS NULL AND task_key=?))`,
        )
        .all(row.id, taskRecordId, row.task_key)
    : conn
        .query<StatusEventMatchRow, [string, string]>(
          `SELECT record_id,task_record_id,task_key,to_status,at FROM task_status_event
           WHERE record_id<>? AND task_key=?`,
        )
        .all(row.id, row.task_key)
  return (
    candidates.find((candidate) =>
      isSameStatusEvent(
        statusEventIdentity(taskRecordId, row.task_key, row.to_status, row.at),
        statusEventIdentity(
          candidate.task_record_id,
          candidate.task_key,
          candidate.to_status,
          candidate.at,
        ),
      ),
    ) ?? null
  )
}

function writeStatusEvent(
  conn: Database,
  row: HostedChanges['statusEvents'][number],
  taskRecordId: string | null,
) {
  const updated = conn
    .query(
      `UPDATE task_status_event SET task_key=?,task_record_id=COALESCE(?,task_record_id),at=?,from_status=?,to_status=? WHERE record_id=?`,
    )
    .run(row.task_key, taskRecordId, row.at, row.from_status, row.to_status, row.id)
  if (!updated.changes)
    conn
      .query(
        `INSERT INTO task_status_event (record_id,task_key,task_record_id,at,from_status,to_status) VALUES (?,?,?,?,?,?)`,
      )
      .run(row.id, row.task_key, taskRecordId, row.at, row.from_status, row.to_status)
}

function retargetStatusEvent(
  conn: Database,
  fromId: string,
  toId: string,
  hostedRowExists: boolean,
) {
  adoptPendingHostedRow(conn, HOSTED_STATUS_EVENT_TABLE, fromId, toId)
  if (hostedRowExists) conn.query(`DELETE FROM task_status_event WHERE record_id=?`).run(fromId)
  else conn.query(`UPDATE task_status_event SET record_id=? WHERE record_id=?`).run(toId, fromId)
}

function applyStatusEvent(conn: Database, row: HostedChanges['statusEvents'][number]) {
  const taskRecordId = taskRecordIdFor(conn, row.task_key, row.project_name)
  if (row.deleted_at) {
    conn.query(`DELETE FROM task_status_event WHERE record_id=?`).run(row.id)
    return
  }
  const existing = conn
    .query<{ record_id: string }, [string]>(
      `SELECT record_id FROM task_status_event WHERE record_id=?`,
    )
    .get(row.id)
  const match = matchingStatusEvent(conn, row, taskRecordId)
  if (match) retargetStatusEvent(conn, match.record_id, row.id, Boolean(existing))
  writeStatusEvent(conn, row, taskRecordId)
}

export function applyHostedTaskRows(conn: Database, changes: HostedChanges) {
  changes.tasks.forEach((row) => {
    applySnapshotRow(conn, 'hub_task', row.id, row, applyHostedTask)
  })
  reconcileParentRecordIds(conn)
  changes.comments.forEach((row) => {
    applySnapshotRow(conn, 'hub_task_comment', row.id, row, applyComment)
  })
  changes.documents.forEach((row) => {
    applySnapshotRow(conn, 'hub_task_document', row.id, row, applyDocument)
  })
  changes.statusEvents.forEach((row) => {
    applySnapshotRow(conn, 'hub_task_status_event', row.id, row, applyStatusEvent)
  })
}

function applySnapshotRow(
  conn: Database,
  table: HostedTaskChangeTable,
  id: string,
  row: HostedChangeRow,
  apply: (conn: Database, row: never) => void,
) {
  reconcilePulledRow(conn, {
    table,
    id,
    operation: row.deleted_at ? 'delete' : 'upsert',
    current: () => hostedChangeMachineRow(conn, table, id),
    apply: () => apply(conn, row as never),
    remove: () => deleteHostedChangeRow(conn, table, id),
  })
}

const hostedTaskChangeTables = {
  hub_task: { machine: HOSTED_MACHINE_TABLES.hub_task, apply: applyHostedTask },
  hub_task_comment: { machine: HOSTED_MACHINE_TABLES.hub_task_comment, apply: applyComment },
  hub_task_document: { machine: HOSTED_MACHINE_TABLES.hub_task_document, apply: applyDocument },
  hub_task_status_event: {
    machine: HOSTED_MACHINE_TABLES.hub_task_status_event,
    apply: applyStatusEvent,
  },
} as const

export type HostedTaskChangeTable = keyof typeof hostedTaskChangeTables

export const HOSTED_TASK_CHANGE_TABLE_QUERY = (
  Object.keys(hostedTaskChangeTables) as HostedTaskChangeTable[]
).join(',')

export function isHostedTaskChangeTable(table: string): table is HostedTaskChangeTable {
  return Object.hasOwn(hostedTaskChangeTables, table)
}

export function applyHostedChangeUpsert(
  conn: Database,
  table: HostedTaskChangeTable,
  row: HostedChangeRow,
) {
  const apply = hostedTaskChangeTables[table].apply as (
    connection: Database,
    record: HostedChangeRow,
  ) => void
  apply(conn, row)
}

export function deleteHostedChangeRow(conn: Database, table: HostedTaskChangeTable, id: string) {
  conn.query(`DELETE FROM ${hostedTaskChangeTables[table].machine} WHERE record_id=?`).run(id)
}

export function hostedChangeMachineRow(
  conn: Database,
  table: HostedTaskChangeTable,
  id: string,
): Record<string, unknown> | null {
  return (
    conn
      .query<Record<string, unknown>, [string]>(
        `SELECT * FROM ${hostedTaskChangeTables[table].machine} WHERE record_id=?`,
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
      `SELECT task_record_id FROM ${hostedTaskChangeTables[table].machine} WHERE record_id=?`,
    )
    .get(id)
  if (!child?.task_record_id) return null
  return (
    conn
      .query<{ project: string }, [string]>(`SELECT project FROM task WHERE record_id=?`)
      .get(child.task_record_id)?.project ?? null
  )
}
