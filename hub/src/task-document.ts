import type { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import type { TaskSource } from '../../shared/task-source.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import { sendHostedChanges } from './hosted-change-sender.ts'
import { applyHostedWriteLocally } from './hosted-local-apply.ts'
import { taskDocumentIdentityByNumber } from './identity/identity.ts'
import { drainHostedEditOutbox, queueHostedDocumentDelete } from './offline-task-edits.ts'
import {
  HOSTED_DOCUMENT_TABLE,
  type HostedPushChange,
  type PushedDocument,
} from './push-contract.ts'
import { hostedCreateDocument, hostedGetTask } from './task-client.ts'
import { demoteOtherTaskDocumentRoleHolders } from './task-document-demotion.ts'
import { formatTaskDocumentLabel, parseTaskDocumentLabel } from './task-document-label.ts'
import {
  type DocumentRoleCandidate,
  documentRole,
  documentRoleRefusal,
  type TaskDocumentRole,
} from './task-document-role.ts'

import {
  missingTaskRecordLine,
  resolveTask,
  type TaskScope,
  taskByRecordId,
  taskRecordId,
} from './task-identity.ts'
import {
  type HostedTaskWriteOptions,
  hostedTaskChangeSendOptions,
  hostedTaskWriteOptions,
  taskWriteMode,
} from './task-write-destination.ts'

export type TaskDocumentSummary = {
  id: string
  number: number
  label: string
  task_key: string
  task_record_id: string
  role: TaskDocumentRole | null
  title: string
  updated_at: string
  body?: string
  version?: string
  created_at?: string
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
  source: TaskSource
  next_document_number: number
}

const documentVersion = () => randomBytes(8).toString('hex')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function documentRecordId(value: string, scope: TaskScope = {}): string {
  if (UUID.test(value)) return value.toLowerCase()
  const label = parseTaskDocumentLabel(value)
  const taskId = resolveTask(db(), label.taskKey, scope.project)
  const recordId = taskDocumentIdentityByNumber(db(), taskId, label.number)
  if (!recordId)
    throw new Error(`no task document ${formatTaskDocumentLabel(label.taskKey, label.number)}`)
  return recordId
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

function taskDocumentFields(changes: {
  title?: string
  body?: string
  role?: string | null
}): string[] {
  return [
    ...(changes.title !== undefined ? ['title'] : []),
    ...(changes.role !== undefined ? ['role'] : []),
    ...(changes.body !== undefined ? ['body', 'version'] : []),
  ]
}

function assertLocalRoleAvailable(
  conn: Database,
  taskRecordId: string,
  taskKey: string,
  role: TaskDocumentRole,
  documentId?: string,
) {
  const documents = conn
    .query<DocumentRoleCandidate, [string]>(
      `SELECT record_id AS id,number,role,title,version FROM task_document
       WHERE task_record_id = ?`,
    )
    .all(taskRecordId)
  const refusal = documentRoleRefusal(documents, taskKey, role, documentId)
  if (refusal) throw new Error(refusal)
}

async function assertHostedRoleAvailable(
  taskKey: string,
  role: TaskDocumentRole,
  options: ReturnType<typeof hostedTaskWriteOptions>,
  documentId?: string,
) {
  const { documents } = await hostedGetTask(taskKey, options)
  const candidates: DocumentRoleCandidate[] = documents.flatMap((document) =>
    document.number === null
      ? []
      : [
          {
            id: document.id,
            number: document.number,
            role: documentRole(document.role),
            title: document.title,
            version: document.version,
          },
        ],
  )
  const refusal = documentRoleRefusal(candidates, taskKey, role, documentId)
  if (refusal) throw new Error(refusal)
}

function createLocalTaskDocument(task: DocumentTask, input: CreateDocumentInput): TaskDocument {
  const at = nowIso()
  const recordId = newRecordId()
  const version = documentVersion()
  return writeTransaction((conn) => {
    const row = conn
      .query<DocumentTask, [string]>(`SELECT * FROM task WHERE record_id = ?`)
      .get(task.record_id)
    if (!row) throw new Error(missingTaskRecordLine(task.record_id))
    if (row.source !== 'local') throw new Error(`task ${row.key} is not local`)
    const number = row.next_document_number
    const role = documentRole(input.role)
    if (role) assertLocalRoleAvailable(conn, row.record_id, row.key, role)
    conn
      .query(`UPDATE task SET next_document_number = ? WHERE record_id = ?`)
      .run(number + 1, row.record_id)
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
  const role = documentRole(input.role)
  const writeOptions = hostedTaskWriteOptions(task.project, hostedOptions)
  if (role) await assertHostedRoleAvailable(task.key, role, writeOptions)
  const hosted = await hostedCreateDocument(
    task.key,
    { title: input.title, body: input.body ?? '', role, version },
    writeOptions,
  )
  if (hosted.number === null)
    throw new Error(`hosted task document ${hosted.id} for task ${task.key} has no number`)
  const hostedNumber = hosted.number
  const document = withDocumentLabel({
    id: hosted.id,
    number: hostedNumber,
    task_key: task.key,
    task_record_id: task.record_id,
    role,
    title: input.title,
    body: input.body ?? '',
    version: hosted.version,
    created_at: hosted.created_at,
    updated_at: hosted.updated_at,
  })
  const applied = applyHostedWriteLocally(
    `${document.label} was created in the hosted record; its local copy will arrive on the next record pull`,
    () =>
      writeTransaction((conn) => {
        if (role) demoteOtherTaskDocumentRoleHolders(conn, task.record_id, role, hosted.id)
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
            role,
            input.title,
            input.body ?? '',
            hosted.version,
            hosted.created_at,
            hosted.updated_at,
          )
        conn
          .query(
            `UPDATE task SET next_document_number=MAX(next_document_number,?) WHERE record_id=?`,
          )
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
  const current = getTaskDocument(value, options.scope),
    id = current.id
  const task = taskByRecordId<DocumentTask>(current.task_record_id)
  if (task.source !== 'local') throw new Error(`task ${current.task_key} is not local`)
  const expectedVersion = changes.expectedVersion
  if (changes.body !== undefined && !expectedVersion)
    throw new Error(`a body update requires --version from \`${PLATFORM_SLUG} task doc show\``)
  const mode = taskWriteMode(task.project, options.hosted)
  const at = nowIso()
  const fields = taskDocumentFields(changes)
  if (mode === 'hosted-configured') {
    if (!expectedVersion)
      throw new Error(
        `a hosted document update requires --version from \`${PLATFORM_SLUG} task doc show\``,
      )
    const role = changes.role === undefined ? current.role : documentRole(changes.role)
    const writeOptions = hostedTaskWriteOptions(task.project, options.hosted)
    if (changes.role !== undefined && role)
      await assertHostedRoleAvailable(current.task_key, role, writeOptions, id)
    const version = documentVersion()
    const row: PushedDocument = {
      id,
      number: current.number,
      task_key: current.task_key,
      task_id: current.task_record_id,
      project_name: task.project,
      projectId: undefined,
      role,
      title: changes.title ?? current.title,
      body: changes.body ?? current.body,
      version,
      created_at: current.created_at,
      updated_at: at,
      deleted_at: null,
    }
    const change: HostedPushChange = {
      table: HOSTED_DOCUMENT_TABLE,
      id,
      op: 'upsert',
      row,
      fields,
      expected_revision: expectedVersion,
    }
    await sendHostedChanges(
      'the record',
      [[change]],
      hostedTaskChangeSendOptions(current.task_key, task.project, options.hosted),
    )
    return withDocumentLabel({
      ...row,
      task_record_id: current.task_record_id,
      role: documentRole(row.role),
      number: current.number,
    })
  }
  writeTransaction((conn) => {
    const row = conn
      .query<Omit<TaskDocument, 'label'>, [string]>(
        `SELECT record_id AS id, number, task_key, task_record_id, role, title, body, version, created_at, updated_at
           FROM task_document WHERE record_id = ?`,
      )
      .get(id)
    if (!row) throw new Error(`no task document ${id}`)
    const nextRole = changes.role === undefined ? row.role : documentRole(changes.role)
    if (changes.role !== undefined && nextRole)
      assertLocalRoleAvailable(conn, row.task_record_id, row.task_key, nextRole, id)
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
      return
    }
    conn
      .query(`UPDATE task_document SET title = ?, role = ?, updated_at = ? WHERE record_id = ?`)
      .run(changes.title ?? row.title, nextRole, at, id)
  })
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
