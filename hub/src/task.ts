import { randomBytes } from 'node:crypto'
import { TASK_STATUSES, trackerCapabilities } from '../../shared/trackers.ts'
import { db, writeTransaction } from './db.ts'
import type { HostedTask } from './hosted-tasks.ts'
import { projects, type StatusCategory } from './projects.ts'
import { runRef } from './reconcile.ts'
import {
  assertHostedTaskWriteConfigured,
  hostedCloseTask,
  hostedCommentTask,
  hostedCreateDocument,
  hostedCreateTask,
  hostedDeleteDocument,
  hostedPatchDocument,
  hostedPatchTask,
  type TaskFetch,
} from './task-client.ts'

export type TaskRow = {
  record_id: string | null
  key: string
  project: string
  title: string | null
  status: string | null
  status_category: StatusCategory | null
  parent_key: string | null
  body: string | null
  assignee: string | null
  opened_at: string | null
  closed_at: string | null
  updated_at: string | null
  source: 'mcp' | 'git' | 'local'
  first_seen: string
  last_seen: string
}

export type TaskComment = {
  id: number
  record_id: string | null
  task_key: string
  body: string
  created_at: string
}

export type DuplicateCandidate = {
  key: string
  status: string | null
  title: string
  score: number
}

export class DuplicateTaskError extends Error {
  readonly candidates: DuplicateCandidate[]

  constructor(candidates: DuplicateCandidate[]) {
    super('possible duplicate tasks')
    this.candidates = candidates
  }
}

const DUPLICATE_STOP_WORDS = new Set(
  'a an and are as at be by for from has have in into is it its of on or that the this to was were will with should before after not no'.split(
    ' ',
  ),
)

// Provisional, measured against the reports that introduced duplicate detection:
// known duplicates scored at least 0.227, while the best unrelated result across
// those searches scored 0.151.
const DUPLICATE_THRESHOLD = 0.2
const DUPLICATE_LIMIT = 3

function titleTokens(title: string): Set<string> {
  return new Set(
    (title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
      (token) => token.length > 1 && !DUPLICATE_STOP_WORDS.has(token),
    ),
  )
}

export function duplicateScore(left: string, right: string): number {
  const a = titleTokens(left)
  const b = titleTokens(right)
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  return intersection / (a.size + b.size - intersection)
}

export function duplicateCandidates(tasks: TaskRow[], title: string): DuplicateCandidate[] {
  return tasks
    .filter((task): task is TaskRow & { title: string } => !!task.title)
    .map((task) => ({
      key: task.key,
      status: task.status,
      title: task.title,
      score: duplicateScore(title, task.title),
    }))
    .filter((candidate) => candidate.score >= DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, DUPLICATE_LIMIT)
}

const TASK_DOCUMENT_ROLES = ['handoff'] as const
type TaskDocumentRole = (typeof TASK_DOCUMENT_ROLES)[number]
export type TaskDocumentSummary = {
  id: number
  record_id: string | null
  task_key: string
  role: TaskDocumentRole | null
  title: string
  updated_at: string
}
export type TaskDocument = TaskDocumentSummary & {
  body: string
  version: string
  created_at: string
}

const documentVersion = () => randomBytes(8).toString('hex')

function documentRole(value: string | null | undefined): TaskDocumentRole | null {
  if (value == null) return null
  if (!(TASK_DOCUMENT_ROLES as readonly string[]).includes(value)) {
    throw new Error(`invalid document role '${value}': expected ${TASK_DOCUMENT_ROLES.join('|')}`)
  }
  return value as TaskDocumentRole
}

function documentId(value: number | string): number {
  const id = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`invalid document id '${value}'`)
  return id
}

function status(value: string | undefined): StatusCategory {
  const candidate = value ?? 'open'
  if (!(TASK_STATUSES as readonly string[]).includes(candidate)) {
    throw new Error(`invalid status '${candidate}': expected ${TASK_STATUSES.join('|')}`)
  }
  return candidate as StatusCategory
}

function registeredProject(name: string) {
  const project = projects().find((candidate) => candidate.name === name)
  if (!project) throw new Error(`unknown project '${name}'`)
  return project
}

function assertParent(key: string | null | undefined) {
  if (!key) return
  const found = db().query<{ key: string }, [string]>(`SELECT key FROM task WHERE key = ?`).get(key)
  if (!found) throw new Error(`no task ${key}`)
}

/** Check, allocate, insert, and record an override under one serialized write transaction. */
type HostedOptions = { baseUrl?: string; token?: string | null; fetch?: TaskFetch }

function cacheTask(conn: import('bun:sqlite').Database, row: HostedTask) {
  conn
    .query(`INSERT INTO task
    (record_id,key,project,title,status,status_category,parent_key,body,assignee,opened_at,closed_at,
     updated_at,source,first_seen,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET record_id=excluded.record_id,project=excluded.project,
      title=excluded.title,status=excluded.status,status_category=excluded.status_category,
      parent_key=excluded.parent_key,body=excluded.body,assignee=excluded.assignee,
      opened_at=excluded.opened_at,closed_at=excluded.closed_at,updated_at=excluded.updated_at,
      source=excluded.source,first_seen=excluded.first_seen,last_seen=excluded.last_seen`)
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

function cacheStatusEvent(
  conn: import('bun:sqlite').Database,
  row: import('./hosted-tasks.ts').HostedStatusEvent | undefined,
) {
  if (!row) return
  conn
    .query(`INSERT OR IGNORE INTO task_status_event(record_id,task_key,at,from_status,to_status)
    VALUES (?,?,?,?,?)`)
    .run(row.id, row.task_key, row.at, row.from_status, row.to_status)
}

export async function createTask(
  input: {
    project: string
    title: string
    status?: string
    parent?: string
    body?: string
    openedAt?: string
    closedAt?: string | null
  },
  options: {
    allowDuplicateReason?: string
    afterDuplicateSearch?: () => void
    hosted?: HostedOptions
    skipDuplicateCheck?: boolean
  } = {},
): Promise<TaskRow> {
  if (!input.title.trim()) throw new Error('task title is required')
  assertHostedTaskWriteConfigured(options.hosted)
  const project = registeredProject(input.project)
  const prefix = project.settings.keyPrefixes?.[0]
  if (!prefix) {
    throw new Error(
      `project '${input.project}' has no key prefix; set one with ` +
        `orch project set ${input.project} --settings '{"keyPrefixes":["ABC"]}'`,
    )
  }
  const category = status(input.status)
  const parent = input.parent?.toUpperCase()
  assertParent(parent)
  void prefix
  const candidates = duplicateCandidates(listTasks({ project: input.project }), input.title)
  options.afterDuplicateSearch?.()
  if (options.allowDuplicateReason !== undefined && !options.allowDuplicateReason.trim())
    throw new Error('--allow-duplicate requires a non-empty reason')
  if (
    candidates.length &&
    options.allowDuplicateReason === undefined &&
    !options.skipDuplicateCheck
  )
    throw new DuplicateTaskError(candidates)
  const hosted = await hostedCreateTask(
    {
      project: input.project,
      title: input.title,
      status: category,
      parent,
      body: input.body,
      opened_at: input.openedAt,
      closed_at: input.closedAt,
      updated_at: input.closedAt ?? input.openedAt,
    },
    options.hosted,
  )
  const comment = options.allowDuplicateReason
    ? await hostedCommentTask(hosted.key, options.allowDuplicateReason, options.hosted)
    : null
  writeTransaction((conn) => {
    cacheTask(conn, hosted)
    if (comment)
      conn
        .query(`INSERT INTO task_comment (record_id,task_key,body,created_at)
      VALUES (?,?,?,?)`)
        .run(comment.id, comment.task_key, comment.body, comment.created_at)
  })
  return showTask(hosted.key).task
}

export function listTasks(
  filters: { project?: string; status?: string; parent?: string } = {},
): TaskRow[] {
  const clauses: string[] = []
  const values: string[] = []
  if (filters.project) {
    registeredProject(filters.project)
    clauses.push('project = ?')
    values.push(filters.project)
  }
  if (filters.status) {
    clauses.push('status_category = ?')
    values.push(status(filters.status))
  }
  if (filters.parent) {
    clauses.push('parent_key = ?')
    values.push(filters.parent.toUpperCase())
  }
  return db()
    .query<TaskRow, string[]>(
      `SELECT * FROM task ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY project, key`,
    )
    .all(...values)
}

export function showTask(key: string): {
  task: TaskRow
  comments: TaskComment[]
  documents: TaskDocumentSummary[]
} {
  const upper = key.toUpperCase()
  const task = db().query<TaskRow, [string]>(`SELECT * FROM task WHERE key = ?`).get(upper)
  if (!task) throw new Error(`no task ${upper}`)
  const comments = db()
    .query<TaskComment, [string]>(
      `SELECT id, record_id, task_key, body, created_at FROM task_comment
      WHERE task_key = ? ORDER BY created_at, id`,
    )
    .all(upper)
  return { task, comments, documents: listTaskDocuments(upper) }
}

export type TaskRun = {
  id: number
  agent: string | null
  job: string | null
  started_at: string
  ended_at: string
  running: boolean
  vendor_tokens: number
  vendor_cost_usd: number | null
}

/** The complete read-only task record used by the dashboard detail sheet. */
export function taskRecord(key: string) {
  const record = showTask(key)
  const project = projects().find((candidate) => candidate.name === record.task.project) ?? null
  const documents = record.documents
    .map((document) => getTaskDocument(document.id))
    .sort((a, b) => Number(b.role === 'handoff') - Number(a.role === 'handoff'))
  const runs = db()
    .query<
      {
        ref: string
        agent: string | null
        job: string | null
        started_at: string
        ended_at: string
        running: number
        vendor_tokens: number
        vendor_cost_usd: number | null
      },
      [string]
    >(
      `SELECT ref, agent, job, MIN(start_at) started_at, MAX(end_at) ended_at,
            MAX(open) running, SUM(vendor_tokens) vendor_tokens,
            SUM(vendor_cost_usd) vendor_cost_usd
       FROM interval
      WHERE task_key = ? AND source = 'orch'
      GROUP BY ref, agent, job
      ORDER BY started_at DESC`,
    )
    .all(record.task.key)
    .flatMap((run): TaskRun[] => {
      const parsed = runRef(run.ref)
      if (!parsed) return []
      return [
        {
          id: parsed.turn ?? parsed.root,
          agent: run.agent,
          job: run.job,
          started_at: run.started_at,
          ended_at: run.ended_at,
          running: Boolean(run.running),
          vendor_tokens: run.vendor_tokens,
          vendor_cost_usd: run.vendor_cost_usd,
        },
      ]
    })
  return {
    task: record.task,
    source: record.task.source,
    sourceProtocol:
      record.task.source === 'mcp' ? (project?.settings.tracker?.protocol ?? null) : null,
    project,
    capabilities: trackerCapabilities({ source: record.task.source, project }),
    runs,
    comments: record.comments,
    documents,
  }
}

export async function setTask(
  key: string,
  changes: {
    title?: string
    status?: string
    parent?: string | null
    body?: string
    assignee?: string | null
  },
  options: { force?: boolean; hosted?: HostedOptions } = {},
): Promise<TaskRow> {
  assertHostedTaskWriteConfigured(options.hosted)
  const upper = key.toUpperCase()
  const current = showTask(upper).task
  if (current.source !== 'local') throw new Error(`task ${upper} is not local`)
  if (
    changes.body !== undefined &&
    current.body !== null &&
    current.body !== '' &&
    !options.force
  ) {
    throw new Error(
      `task ${upper} already has a body:\n\n${current.body}\n\n` + 'Pass --force to overwrite it.',
    )
  }
  const category = changes.status === undefined ? current.status_category : status(changes.status)
  const parent =
    changes.parent === undefined ? current.parent_key : (changes.parent?.toUpperCase() ?? null)
  assertParent(parent)
  const hosted = await hostedPatchTask(
    upper,
    {
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.status !== undefined ? { status: category, status_category: category } : {}),
      ...(changes.parent !== undefined ? { parent_key: parent } : {}),
      ...(changes.body !== undefined ? { body: changes.body } : {}),
      ...(changes.assignee !== undefined ? { assignee: changes.assignee } : {}),
    },
    options.hosted,
  )
  writeTransaction((conn) => {
    cacheTask(conn, hosted)
    cacheStatusEvent(conn, hosted.status_event)
  })
  return showTask(upper).task
}

export async function closeTask(key: string, options: { hosted?: HostedOptions } = {}) {
  assertHostedTaskWriteConfigured(options.hosted)
  const hosted = await hostedCloseTask(key.toUpperCase(), options.hosted)
  writeTransaction((conn) => {
    cacheTask(conn, hosted)
    cacheStatusEvent(conn, hosted.status_event)
  })
  return showTask(key).task
}

export async function commentTask(
  key: string,
  body: string,
  options: { hosted?: HostedOptions } = {},
): Promise<TaskComment> {
  assertHostedTaskWriteConfigured(options.hosted)
  const upper = key.toUpperCase()
  const current = showTask(upper).task
  if (current.source !== 'local') throw new Error(`task ${upper} is not local`)
  const comment = await hostedCommentTask(upper, body, options.hosted)
  const result = writeTransaction((conn) => {
    const inserted = conn
      .query(`INSERT INTO task_comment (record_id,task_key,body,created_at) VALUES (?,?,?,?)`)
      .run(comment.id, upper, body, comment.created_at)
    conn
      .query(`UPDATE task SET updated_at = ?, last_seen = ? WHERE key = ?`)
      .run(comment.updated_at, comment.updated_at, upper)
    return inserted
  })
  return {
    id: Number(result.lastInsertRowid),
    record_id: comment.id,
    task_key: upper,
    body,
    created_at: comment.created_at,
  }
}

export function listTaskDocuments(key: string): TaskDocumentSummary[] {
  const upper = key.toUpperCase()
  const task = db()
    .query<{ key: string }, [string]>(`SELECT key FROM task WHERE key = ?`)
    .get(upper)
  if (!task) throw new Error(`no task ${upper}`)
  return db()
    .query<TaskDocumentSummary, [string]>(
      `SELECT id, record_id, task_key, role, title, updated_at FROM task_document
      WHERE task_key = ? ORDER BY created_at, id`,
    )
    .all(upper)
}

export function getTaskDocument(idValue: number | string): TaskDocument {
  const id = documentId(idValue)
  const document = db()
    .query<TaskDocument, [number]>(
      `SELECT id, record_id, task_key, role, title, body, version, created_at, updated_at
       FROM task_document WHERE id = ?`,
    )
    .get(id)
  if (!document) throw new Error(`no task document ${id}`)
  return document
}

export async function createTaskDocument(
  input: {
    task: string
    title: string
    body?: string
    role?: string
  },
  options: { hosted?: HostedOptions } = {},
): Promise<TaskDocument> {
  assertHostedTaskWriteConfigured(options.hosted)
  const upper = input.task.toUpperCase()
  const task = showTask(upper).task
  if (task.source !== 'local') throw new Error(`task ${upper} is not local`)
  const version = documentVersion()
  const hosted = await hostedCreateDocument(
    upper,
    { title: input.title, body: input.body ?? '', role: documentRole(input.role), version },
    options.hosted,
  )
  const result = writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO task_document (record_id,task_key,role,title,body,version,created_at,updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hosted.id,
        upper,
        documentRole(input.role),
        input.title,
        input.body ?? '',
        hosted.version,
        hosted.created_at,
        hosted.updated_at,
      ),
  )
  return getTaskDocument(Number(result.lastInsertRowid))
}

export async function updateTaskDocument(
  idValue: number | string,
  changes: {
    title?: string
    body?: string
    role?: string | null
    expectedVersion?: string
  },
  options: { hosted?: HostedOptions } = {},
): Promise<TaskDocument> {
  assertHostedTaskWriteConfigured(options.hosted)
  const id = documentId(idValue)
  const current = getTaskDocument(id)
  const task = showTask(current.task_key).task
  if (task.source !== 'local') throw new Error(`task ${current.task_key} is not local`)
  const role = changes.role === undefined ? current.role : documentRole(changes.role)
  if (changes.body !== undefined && !changes.expectedVersion)
    throw new Error('a body update requires --version from `hub task doc show`')
  if (!current.record_id)
    throw new Error(
      `task document ${id} has not been synchronized; run the hosted push and collector`,
    )
  const hosted = await hostedPatchDocument(
    current.task_key,
    current.record_id,
    {
      ...changes,
      role,
      version: documentVersion(),
    },
    options.hosted,
  )
  writeTransaction((conn) =>
    conn
      .query(`UPDATE task_document SET role=?,title=?,body=?,version=?,updated_at=? WHERE id=?`)
      .run(hosted.role, hosted.title, hosted.body, hosted.version, hosted.updated_at, id),
  )
  return getTaskDocument(id)
}

export async function deleteTaskDocument(
  idValue: number | string,
  options: { hosted?: HostedOptions } = {},
): Promise<TaskDocument> {
  assertHostedTaskWriteConfigured(options.hosted)
  const id = documentId(idValue)
  let removed: TaskDocument | null = null
  removed = getTaskDocument(id)
  const task = showTask(removed.task_key).task
  if (task.source !== 'local') throw new Error(`task ${removed.task_key} is not local`)
  if (!removed.record_id)
    throw new Error(
      `task document ${id} has not been synchronized; run the hosted push and collector`,
    )
  await hostedDeleteDocument(removed.task_key, removed.record_id, options.hosted)
  writeTransaction((conn) => conn.query(`DELETE FROM task_document WHERE id = ?`).run(id))
  return removed!
}
