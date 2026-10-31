import { randomBytes } from 'node:crypto'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import {
  applyHostedWriteLocally,
  drainHostedEditOutbox,
  queueHostedDocumentDelete,
  queueHostedDocumentUpsert,
} from './offline-task-edits.ts'
import { hostedCreateDocument } from './task-client.ts'
import { formatTaskDocumentLabel, parseTaskDocumentLabel } from './task-document-label.ts'
import { resolveTask, type TaskScope, taskByRecordId, taskRecordId } from './task-identity.ts'
import {
  type HostedTaskWriteOptions,
  hostedTaskWriteOptions,
  taskWriteMode,
} from './task-write-destination.ts'

const TASK_DOCUMENT_ROLES = ['handoff'] as const
type TaskDocumentRole = (typeof TASK_DOCUMENT_ROLES)[number]
export type TaskDocumentSummary = {
  id: string
  number: number
  label: string
  task_key: string
  task_record_id: string
  role: TaskDocumentRole | null
  title: string
  updated_at: string
}
export type TaskDocument = TaskDocumentSummary & {
  body: string
  version: string
  created_at: string
}

type DocumentTask = {
  record_id: string
  key: string
  project: string
  source: 'mcp' | 'git' | 'local'
  next_document_number: number
}

const documentVersion = () => randomBytes(8).toString('hex')

function documentRole(value: string | null | undefined): TaskDocumentRole | null {
  if (value == null) return null
  if (!(TASK_DOCUMENT_ROLES as readonly string[]).includes(value)) {
    throw new Error(`invalid document role '${value}': expected ${TASK_DOCUMENT_ROLES.join('|')}`)
  }
  return value as TaskDocumentRole
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function documentRecordId(value: string, scope: TaskScope = {}): string {
  if (UUID.test(value)) return value.toLowerCase()
  const label = parseTaskDocumentLabel(value)
  const taskId = resolveTask(db(), label.taskKey, scope.project)
  const row = db()
    .query<{ record_id: string }, [string, number]>(
      `SELECT record_id FROM task_document WHERE task_record_id = ? AND number = ?`,
    )
    .get(taskId, label.number)
  if (!row)
    throw new Error(`no task document ${formatTaskDocumentLabel(label.taskKey, label.number)}`)
  return row.record_id
}

function withDocumentLabel<T extends Omit<TaskDocumentSummary, 'label'>>(
  row: T,
): T & { label: string } {
  return { ...row, label: formatTaskDocumentLabel(row.task_key, row.number) }
}

export function listTaskDocuments(key: string, scope: TaskScope = {}): TaskDocumentSummary[] {
  const upper = key.toUpperCase()
  const recordId = taskRecordId(upper, scope)
  return db()
    .query<Omit<TaskDocumentSummary, 'label'>, [string]>(
      `SELECT record_id AS id, number, task_key, task_record_id, role, title, updated_at FROM task_document
      WHERE task_record_id = ? ORDER BY number`,
    )
    .all(recordId)
    .map(withDocumentLabel)
}

export function getTaskDocument(value: string, scope: TaskScope = {}): TaskDocument {
  const id = documentRecordId(value, scope)
  const document = db()
    .query<Omit<TaskDocument, 'label'>, [string]>(
      `SELECT record_id AS id, number, task_key, task_record_id, role, title, body, version, created_at, updated_at
       FROM task_document WHERE record_id = ?`,
    )
    .get(id)
  if (!document) throw new Error(`no task document ${id}`)
  return withDocumentLabel(document)
}

type CreateDocumentInput = { task: string; title: string; body?: string; role?: string }

function createLocalTaskDocument(task: DocumentTask, input: CreateDocumentInput): TaskDocument {
  const at = nowIso()
  const recordId = newRecordId()
  const version = documentVersion()
  return writeTransaction((conn) => {
    const row = conn
      .query<DocumentTask, [string]>(`SELECT * FROM task WHERE record_id = ?`)
      .get(task.record_id)
    if (!row) throw new Error(`no task record ${task.record_id}`)
    if (row.source !== 'local') throw new Error(`task ${row.key} is not local`)
    const number = row.next_document_number
    conn
      .query(`UPDATE task SET next_document_number = ? WHERE record_id = ?`)
      .run(number + 1, row.record_id)
    const role = documentRole(input.role)
    conn
      .query(
        `INSERT INTO task_document (record_id,task_key,task_record_id,number,role,title,body,version,created_at,updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        recordId,
        row.key,
        row.record_id,
        number,
        role,
        input.title,
        input.body ?? '',
        version,
        at,
        at,
      )
    return withDocumentLabel({
      id: recordId,
      number,
      task_key: row.key,
      task_record_id: row.record_id,
      role,
      title: input.title,
      body: input.body ?? '',
      version,
      created_at: at,
      updated_at: at,
    })
  })
}

async function createHostedTaskDocument(
  task: DocumentTask,
  input: CreateDocumentInput,
  hostedOptions?: HostedTaskWriteOptions,
): Promise<TaskDocument> {
  const version = documentVersion()
  const hosted = await hostedCreateDocument(
    task.key,
    { title: input.title, body: input.body ?? '', role: documentRole(input.role), version },
    hostedTaskWriteOptions(task.project, hostedOptions),
  )
  if (hosted.number === null)
    throw new Error(`hosted task document ${hosted.id} for task ${task.key} has no number`)
  const hostedNumber = hosted.number
  const document = withDocumentLabel({
    id: hosted.id,
    number: hostedNumber,
    task_key: task.key,
    task_record_id: task.record_id,
    role: documentRole(input.role),
    title: input.title,
    body: input.body ?? '',
    version: hosted.version,
    created_at: hosted.created_at,
    updated_at: hosted.updated_at,
  })
  const applied = applyHostedWriteLocally(document.label, 'created', () =>
    writeTransaction((conn) => {
      conn
        .query(
          `INSERT INTO task_document (record_id,task_key,task_record_id,number,role,title,body,version,created_at,updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          hosted.id,
          task.key,
          task.record_id,
          hostedNumber,
          documentRole(input.role),
          input.title,
          input.body ?? '',
          hosted.version,
          hosted.created_at,
          hosted.updated_at,
        )
      conn
        .query(`UPDATE task SET next_document_number=MAX(next_document_number,?) WHERE record_id=?`)
        .run(hostedNumber + 1, task.record_id)
    }),
  )
  return applied ? getTaskDocument(hosted.id) : document
}

export async function createTaskDocument(
  input: CreateDocumentInput,
  scope: TaskScope,
  options: { hosted?: HostedTaskWriteOptions } = {},
): Promise<TaskDocument> {
  const upper = input.task.toUpperCase()
  const task = taskByRecordId<DocumentTask>(taskRecordId(upper, scope))
  if (task.source !== 'local') throw new Error(`task ${upper} is not local`)
  const mode = taskWriteMode(task.project, options.hosted)
  return mode === 'local-authoritative'
    ? createLocalTaskDocument(task, input)
    : createHostedTaskDocument(task, input, options.hosted)
}

export async function updateTaskDocument(
  value: string,
  changes: {
    title?: string
    body?: string
    role?: string | null
    expectedVersion?: string
  },
  options: { hosted?: HostedTaskWriteOptions; scope?: TaskScope } = {},
): Promise<TaskDocument> {
  const current = getTaskDocument(value, options.scope)
  const id = current.id
  const task = taskByRecordId<DocumentTask>(current.task_record_id)
  if (task.source !== 'local') throw new Error(`task ${current.task_key} is not local`)
  const expectedVersion = changes.expectedVersion
  if (changes.body !== undefined && !expectedVersion)
    throw new Error(`a body update requires --version from \`${PLATFORM_SLUG} task doc show\``)
  const mode = taskWriteMode(task.project, options.hosted)
  const hosted = mode === 'hosted-configured'
  const at = nowIso()
  const fields = [
    ...(changes.title !== undefined ? ['title'] : []),
    ...(changes.role !== undefined ? ['role'] : []),
    ...(changes.body !== undefined ? ['body', 'version'] : []),
  ]
  writeTransaction((conn) => {
    const row = conn
      .query<Omit<TaskDocument, 'label'>, [string]>(
        `SELECT record_id AS id, number, task_key, task_record_id, role, title, body, version, created_at, updated_at
           FROM task_document WHERE record_id = ?`,
      )
      .get(id)
    if (!row) throw new Error(`no task document ${id}`)
    const nextRole = changes.role === undefined ? row.role : documentRole(changes.role)
    if (changes.body !== undefined) {
      const result = conn
        .query(
          `UPDATE task_document
              SET title = ?, role = ?, body = ?, version = ?, updated_at = ?
            WHERE record_id = ? AND version = ?`,
        )
        .run(
          changes.title ?? row.title,
          nextRole,
          changes.body,
          documentVersion(),
          at,
          id,
          expectedVersion ?? row.version,
        )
      if (result.changes !== 1) {
        throw new Error(
          `task document ${id} changed since version ${expectedVersion}; read it again`,
        )
      }
      if (hosted) queueHostedDocumentUpsert(conn, id, at, fields)
      return
    }
    conn
      .query(`UPDATE task_document SET title = ?, role = ?, updated_at = ? WHERE record_id = ?`)
      .run(changes.title ?? row.title, nextRole, at, id)
    if (hosted) queueHostedDocumentUpsert(conn, id, at, fields)
  })
  if (hosted) await drainHostedEditOutbox(at, options.hosted)
  return getTaskDocument(id)
}

export async function deleteTaskDocument(
  value: string,
  options: { hosted?: HostedTaskWriteOptions; scope?: TaskScope } = {},
): Promise<TaskDocument> {
  const removed = getTaskDocument(value, options.scope)
  const id = removed.id
  const task = taskByRecordId<DocumentTask>(removed.task_record_id)
  if (task.source !== 'local') throw new Error(`task ${removed.task_key} is not local`)
  const mode = taskWriteMode(task.project, options.hosted)
  const hosted = mode === 'hosted-configured'
  const at = nowIso()
  const result = writeTransaction((conn) => {
    const row = conn
      .query<Omit<TaskDocument, 'label'>, [string]>(
        `SELECT record_id AS id, number, task_key, task_record_id, role, title, body, version, created_at, updated_at
           FROM task_document WHERE record_id = ?`,
      )
      .get(id)
    if (!row) throw new Error(`no task document ${id}`)
    if (hosted) queueHostedDocumentDelete(conn, id, task.project, at)
    conn.query(`DELETE FROM task_document WHERE record_id = ?`).run(id)
    return withDocumentLabel(row)
  })
  if (hosted) await drainHostedEditOutbox(at, options.hosted)
  return result
}
