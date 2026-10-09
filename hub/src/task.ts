import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../shared/record/schema.ts'
import { TASK_STATUSES, trackerCapabilities } from '../../shared/trackers.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import type { HostedTask } from './hosted-tasks.ts'
import { persistInstallBinding } from './install-binding.ts'
import { type BranchPruneResult, classifyTaskBranches } from './orch.ts'
import { projects, type StatusCategory } from './projects.ts'
import { runRef } from './reconcile.ts'
import {
  hostedCloseTask,
  hostedCommentTask,
  hostedCreateTask,
  hostedPatchTask,
} from './task-client.ts'
import { decideTaskClose, landingCheck } from './task-close-decision.ts'
import { getTaskDocument, listTaskDocuments, type TaskDocumentSummary } from './task-document.ts'
import {
  resolveTask,
  type TaskScope,
  taskByRecordId,
  taskIdentityDecision,
  taskRecordId,
  taskRecordIdFor,
} from './task-identity.ts'
import {
  type HostedTaskWriteOptions,
  hostedTaskWriteOptions,
  registeredTaskProject,
  taskWriteMode,
} from './task-write-destination.ts'
import { taskCreationDestination } from './tracker-new.ts'

export type TaskRow = {
  record_id: string
  external_id: string | null
  key: string
  project: string
  title: string | null
  status: string | null
  status_category: StatusCategory | null
  parent_key: string | null
  parent_record_id: string | null
  body: string | null
  assignee: string | null
  opened_at: string | null
  closed_at: string | null
  updated_at: string | null
  source: 'mcp' | 'git' | 'local'
  first_seen: string
  last_seen: string
  next_document_number: number
}

export type TaskComment = {
  id: string
  task_key: string
  task_record_id: string
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

function status(value: string | undefined): StatusCategory {
  const candidate = value ?? 'open'
  if (!(TASK_STATUSES as readonly string[]).includes(candidate)) {
    throw new Error(`invalid status '${candidate}': expected ${TASK_STATUSES.join('|')}`)
  }
  return candidate as StatusCategory
}

const registeredProject = registeredTaskProject

function assertParent(key: string | null | undefined, project?: string) {
  if (!key) return null
  return resolveTask(db(), key, project)
}

/** Check, allocate, insert, and record an override under one serialized write transaction. */
type HostedOptions = HostedTaskWriteOptions
const hostedOptionsForProject = hostedTaskWriteOptions

type DoneTransitionOptions = {
  abandonReason?: string
  classify?: (project: string, key: string) => Promise<BranchPruneResult>
  comment?: typeof commentTask
}

const writeMode = taskWriteMode

function mintLocalTaskKey(conn: Database, prefix: string): string {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`, 'i')
  const highest = conn
    .query<{ key: string }, []>(`SELECT key FROM task`)
    .all()
    .reduce((max, row) => {
      const match = pattern.exec(row.key)
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
  const sequence = conn
    .query<{ next: number }, [string]>(`SELECT next FROM seq WHERE name = ?`)
    .get(`task:${prefix}`)
  const number = Math.max(highest + 1, sequence?.next ?? 1)
  conn
    .query(
      `INSERT INTO seq (name, next) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET next = excluded.next`,
    )
    .run(`task:${prefix}`, number + 1)
  return `${prefix.toUpperCase()}-${number}`
}

function recordLocalStatusChange(
  conn: Database,
  task: { key: string; record_id: string; status_category: StatusCategory | null },
  next: StatusCategory | null,
  at: string,
) {
  if (!next || next === task.status_category) return
  conn
    .query(
      `INSERT OR IGNORE INTO task_status_event(record_id,task_key,task_record_id,at,from_status,to_status)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(newRecordId(), task.key, task.record_id, at, task.status_category, next)
}

export function createLocalTaskInTransaction(
  conn: Database,
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
    skipDuplicateCheck?: boolean
    afterDuplicateSearch?: () => void
  } = {},
): TaskRow {
  const project = registeredProject(input.project)
  if (taskCreationDestination(project) === 'tracker')
    throw new Error(
      `project '${input.project}' owns task creation in its tracker; use hub task new --project ${input.project} --title "..."`,
    )
  const prefix = project.settings.keyPrefixes?.[0]
  if (!prefix) {
    throw new Error(
      `project '${input.project}' has no key prefix; set one with ` +
        `orch project set ${input.project} --settings '{"keyPrefixes":["ABC"]}'`,
    )
  }
  const category = status(input.status)
  const parent = input.parent?.toUpperCase()
  const parentRecordId = parent ? taskRecordIdFor(conn, parent, input.project) : null
  if (parent && !parentRecordId) throw new Error(`no task ${parent}`)
  const candidates = duplicateCandidates(
    conn
      .query<TaskRow, [string]>(`SELECT * FROM task WHERE project = ? ORDER BY key`)
      .all(input.project),
    input.title,
  )
  options.afterDuplicateSearch?.()
  if (options.allowDuplicateReason !== undefined && !options.allowDuplicateReason.trim())
    throw new Error('--allow-duplicate requires a non-empty reason')
  if (
    candidates.length &&
    options.allowDuplicateReason === undefined &&
    !options.skipDuplicateCheck
  )
    throw new DuplicateTaskError(candidates)
  const at = input.openedAt ?? nowIso()
  const closedAt = input.closedAt ?? (category === 'done' ? at : null)
  const updatedAt = input.closedAt ?? input.openedAt ?? at
  const key = mintLocalTaskKey(conn, prefix)
  const recordId = newRecordId()
  conn
    .query(
      `INSERT INTO task
      (record_id,key,project,title,status,status_category,parent_key,parent_record_id,body,assignee,
       opened_at,closed_at,updated_at,source,first_seen,last_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'local',?,?)`,
    )
    .run(
      recordId,
      key,
      input.project,
      input.title,
      category,
      category,
      parent ?? null,
      parentRecordId,
      input.body ?? null,
      null,
      at,
      closedAt,
      updatedAt,
      at,
      updatedAt,
    )
  if (options.allowDuplicateReason !== undefined) {
    conn
      .query(
        `INSERT INTO task_comment (record_id,task_key,task_record_id,body,created_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(newRecordId(), key, recordId, options.allowDuplicateReason, updatedAt)
  }
  const row = conn.query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id = ?`).get(recordId)
  if (!row) throw new Error(`no task record ${recordId}`)
  return row
}

function cacheTask(conn: import('bun:sqlite').Database, row: HostedTask) {
  const parentRecordId = row.parent_key ? taskRecordIdFor(conn, row.parent_key, row.project) : null
  conn
    .query(`INSERT INTO task
    (record_id,key,project,title,status,status_category,parent_key,parent_record_id,body,assignee,opened_at,closed_at,
     updated_at,source,first_seen,last_seen,next_document_number)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project,key) DO UPDATE SET record_id=excluded.record_id,
      title=excluded.title,status=excluded.status,status_category=excluded.status_category,
      parent_key=excluded.parent_key,parent_record_id=excluded.parent_record_id,
      body=excluded.body,assignee=excluded.assignee,
      opened_at=excluded.opened_at,closed_at=excluded.closed_at,updated_at=excluded.updated_at,
      source=excluded.source,first_seen=excluded.first_seen,last_seen=excluded.last_seen,
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
  persistInstallBinding(conn)
}

function cacheStatusEvent(
  conn: import('bun:sqlite').Database,
  row: import('./hosted-tasks.ts').HostedStatusEvent | undefined,
  project: string,
  resolvedTaskRecordId?: string | null,
) {
  if (!row) return
  const taskRecordId = resolvedTaskRecordId ?? taskRecordIdFor(conn, row.task_key, project)
  conn
    .query(`INSERT OR IGNORE INTO task_status_event(record_id,task_key,task_record_id,at,from_status,to_status)
    VALUES (?,?,?,?,?,?)`)
    .run(row.id, row.task_key, taskRecordId, row.at, row.from_status, row.to_status)
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
  const project = registeredProject(input.project)
  if (taskCreationDestination(project) === 'tracker')
    throw new Error(
      `project '${input.project}' owns task creation in its tracker; use hub task new --project ${input.project} --title "..."`,
    )
  const mode = writeMode(input.project, options.hosted)
  if (mode === 'local-authoritative') {
    return writeTransaction((conn) => createLocalTaskInTransaction(conn, input, options))
  }
  const prefix = project.settings.keyPrefixes?.[0]
  if (!prefix) {
    throw new Error(
      `project '${input.project}' has no key prefix; set one with ` +
        `orch project set ${input.project} --settings '{"keyPrefixes":["ABC"]}'`,
    )
  }
  const category = status(input.status)
  const parent = input.parent?.toUpperCase()
  assertParent(parent, input.project)
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
    hostedOptionsForProject(input.project, options.hosted),
  )
  const comment = options.allowDuplicateReason
    ? await hostedCommentTask(
        hosted.key,
        options.allowDuplicateReason,
        hostedOptionsForProject(input.project, options.hosted),
      )
    : null
  writeTransaction((conn) => {
    cacheTask(conn, hosted)
    if (comment)
      conn
        .query(`INSERT INTO task_comment (record_id,task_key,task_record_id,body,created_at)
      VALUES (?,?,?,?,?)`)
        .run(comment.id, comment.task_key, hosted.id, comment.body, comment.created_at)
  })
  return showTask(hosted.key, { recordId: hosted.id }).task
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
    clauses.push('parent_record_id = ?')
    values.push(resolveTask(db(), filters.parent, filters.project))
  }
  return db()
    .query<TaskRow, string[]>(
      `SELECT * FROM task ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY project, key`,
    )
    .all(...values)
}

export function showTask(
  key: string,
  scope: TaskScope = {},
): {
  task: TaskRow
  comments: TaskComment[]
  documents: TaskDocumentSummary[]
} {
  const upper = key.toUpperCase()
  const recordId = taskRecordId(upper, scope)
  const task = taskByRecordId<TaskRow>(recordId)
  const comments = db()
    .query<TaskComment, [string]>(
      `SELECT record_id AS id, task_key, task_record_id, body, created_at FROM task_comment
      WHERE task_record_id = ? ORDER BY created_at, record_id`,
    )
    .all(recordId)
  return { task, comments, documents: listTaskDocuments(upper, { recordId }) }
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
export function taskRecord(key: string, scope: TaskScope = {}) {
  const record = showTask(key, scope)
  const project = projects().find((candidate) => candidate.name === record.task.project) ?? null
  const documents = record.documents
    .map((document) => getTaskDocument(document.id))
    .sort((a, b) => Number(b.role === 'handoff') - Number(a.role === 'handoff'))
  const runs = db()
    .query<
      {
        task_key: string
        ref: string
        agent: string | null
        job: string | null
        started_at: string
        ended_at: string
        running: number
        vendor_tokens: number
        vendor_cost_usd: number | null
      },
      [string, string]
    >(
      `SELECT task_key, ref, agent, job, MIN(start_at) started_at, MAX(end_at) ended_at,
            MAX(open) running, SUM(vendor_tokens) vendor_tokens,
            SUM(vendor_cost_usd) vendor_cost_usd
       FROM interval
      WHERE task_key = ? AND project = ? AND source = 'orch'
      GROUP BY ref, agent, job
      ORDER BY started_at DESC`,
    )
    .all(record.task.key, record.task.project)
    .filter((run) => {
      const decision = taskIdentityDecision(db(), run.task_key, record.task.project)
      if ('one' in decision) return decision.one === record.task.record_id
      if ('several' in decision)
        throw new Error(`task ${run.task_key} is ambiguous; pass --project`)
      return false
    })
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

function assertLocalTaskBodyOverwrite(task: TaskRow, body: string | undefined, force?: boolean) {
  if (body === undefined || task.body === null || task.body === '' || force) return
  throw new Error(
    `task ${task.key} already has a body:\n\n${task.body}\n\nPass --force to overwrite it.`,
  )
}

function applyLocalTaskPatch(
  conn: Database,
  recordId: string,
  changes: {
    title?: string
    status?: string
    parent?: string | null
    body?: string
    assignee?: string | null
  },
  options: { force?: boolean },
  at: string,
): TaskRow {
  const current = conn
    .query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id = ?`)
    .get(recordId)
  if (!current) throw new Error(`no task record ${recordId}`)
  if (current.source !== 'local') throw new Error(`task ${current.key} is not local`)
  assertLocalTaskBodyOverwrite(current, changes.body, options.force)
  const category = changes.status === undefined ? current.status_category : status(changes.status)
  const parent =
    changes.parent === undefined ? current.parent_key : (changes.parent?.toUpperCase() ?? null)
  const parentRecordId = parent ? taskRecordIdFor(conn, parent, current.project) : null
  if (parent && !parentRecordId) throw new Error(`no task ${parent}`)
  conn
    .query(
      `UPDATE task SET title = ?, status = ?, status_category = ?, parent_key = ?, parent_record_id = ?,
                     body = ?, assignee = ?,
                     closed_at = CASE WHEN ? = 'done' THEN COALESCE(closed_at, ?) ELSE NULL END,
                     updated_at = ?, last_seen = ?
       WHERE record_id = ?`,
    )
    .run(
      changes.title ?? current.title,
      category,
      category,
      parent,
      parentRecordId,
      changes.body !== undefined ? changes.body : current.body,
      changes.assignee !== undefined ? changes.assignee : current.assignee,
      category,
      at,
      at,
      at,
      current.record_id,
    )
  recordLocalStatusChange(conn, current, category, at)
  const row = conn.query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id = ?`).get(recordId)
  if (!row) throw new Error(`no task record ${recordId}`)
  return row
}

async function prepareDoneTransition(
  current: TaskRow,
  options: { hosted?: HostedOptions } & DoneTransitionOptions,
): Promise<void> {
  if (options.abandonReason && current.source !== 'local') {
    throw new Error(
      `cannot abandon unlanded work for task ${current.key}: task is not local and cannot take a comment`,
    )
  }
  let classification: ReturnType<typeof landingCheck>
  try {
    classification = landingCheck(
      await (options.classify ?? classifyTaskBranches)(current.project, current.key),
    )
  } catch (error) {
    classification = {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  const decision = decideTaskClose(classification, options.abandonReason)
  if (decision.action === 'refuse') throw new Error(decision.reason)
  if (decision.comment !== null) {
    await (options.comment ?? commentTask)(
      current.key,
      { recordId: current.record_id },
      decision.comment,
      { hosted: options.hosted },
    )
  }
}

export async function setTask(
  key: string,
  scope: TaskScope,
  changes: {
    title?: string
    status?: string
    parent?: string | null
    body?: string
    assignee?: string | null
  },
  options: { force?: boolean; hosted?: HostedOptions } & DoneTransitionOptions = {},
): Promise<TaskRow> {
  const upper = key.toUpperCase()
  const current = showTask(upper, scope).task
  if (current.source !== 'local') throw new Error(`task ${upper} is not local`)
  assertLocalTaskBodyOverwrite(current, changes.body, options.force)
  const category = changes.status === undefined ? current.status_category : status(changes.status)
  const parent =
    changes.parent === undefined ? current.parent_key : (changes.parent?.toUpperCase() ?? null)
  assertParent(parent, current.project)
  if (category === 'done' && current.status_category !== 'done') {
    await prepareDoneTransition(current, options)
  }
  const mode = writeMode(current.project, options.hosted)
  if (mode === 'local-authoritative') {
    const at = nowIso()
    return writeTransaction((conn) =>
      applyLocalTaskPatch(conn, current.record_id, changes, options, at),
    )
  }
  const hosted = await hostedPatchTask(
    current.key,
    {
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.status !== undefined ? { status: category, status_category: category } : {}),
      ...(changes.parent !== undefined ? { parent_key: parent } : {}),
      ...(changes.body !== undefined ? { body: changes.body } : {}),
      ...(changes.assignee !== undefined ? { assignee: changes.assignee } : {}),
    },
    hostedOptionsForProject(current.project, options.hosted),
  )
  writeTransaction((conn) => {
    cacheTask(conn, hosted)
    cacheStatusEvent(conn, hosted.status_event, current.project, current.record_id)
  })
  return showTask(upper, { recordId: current.record_id! }).task
}

export async function closeTask(
  key: string,
  scope: TaskScope,
  options: { hosted?: HostedOptions } & DoneTransitionOptions = {},
) {
  const current = showTask(key, scope).task
  if (current.status_category !== 'done') await prepareDoneTransition(current, options)
  const mode = writeMode(current.project, options.hosted)
  if (mode === 'local-authoritative') {
    const at = nowIso()
    return writeTransaction((conn) => {
      const row = conn
        .query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id = ?`)
        .get(current.record_id)
      if (!row) throw new Error(`no task record ${current.record_id}`)
      conn
        .query(
          `UPDATE task SET status = 'done', status_category = 'done',
                         closed_at = COALESCE(closed_at, ?), updated_at = ?, last_seen = ?
           WHERE record_id = ?`,
        )
        .run(at, at, at, row.record_id)
      recordLocalStatusChange(conn, row, 'done', at)
      const closed = conn
        .query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id = ?`)
        .get(row.record_id)
      if (!closed) throw new Error(`no task record ${row.record_id}`)
      return closed
    })
  }
  const hosted = await hostedCloseTask(
    current.key,
    hostedOptionsForProject(current.project, options.hosted),
  )
  writeTransaction((conn) => {
    cacheTask(conn, hosted)
    cacheStatusEvent(conn, hosted.status_event, current.project, current.record_id)
  })
  return showTask(current.key, { recordId: current.record_id! }).task
}

export async function commentTask(
  key: string,
  scope: TaskScope,
  body: string,
  options: { hosted?: HostedOptions } = {},
): Promise<TaskComment> {
  const upper = key.toUpperCase()
  const current = showTask(upper, scope).task
  if (current.source !== 'local') throw new Error(`task ${upper} is not local`)
  const mode = writeMode(current.project, options.hosted)
  if (mode === 'local-authoritative') {
    const at = nowIso()
    const recordId = newRecordId()
    return writeTransaction((conn) => {
      const row = conn
        .query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id = ?`)
        .get(current.record_id)
      if (!row) throw new Error(`no task record ${current.record_id}`)
      if (row.source !== 'local') throw new Error(`task ${row.key} is not local`)
      conn
        .query(
          `INSERT INTO task_comment (record_id,task_key,task_record_id,body,created_at) VALUES (?,?,?,?,?)`,
        )
        .run(recordId, row.key, row.record_id, body, at)
      conn
        .query(`UPDATE task SET updated_at = ?, last_seen = ? WHERE record_id = ?`)
        .run(at, at, row.record_id)
      return {
        id: recordId,
        task_key: row.key,
        task_record_id: row.record_id,
        body,
        created_at: at,
      }
    })
  }
  const comment = await hostedCommentTask(
    current.key,
    body,
    hostedOptionsForProject(current.project, options.hosted),
  )
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO task_comment (record_id,task_key,task_record_id,body,created_at) VALUES (?,?,?,?,?)`,
      )
      .run(comment.id, current.key, current.record_id, body, comment.created_at)
    conn
      .query(`UPDATE task SET updated_at = ?, last_seen = ? WHERE record_id = ?`)
      .run(comment.updated_at, comment.updated_at, current.record_id)
  })
  return {
    id: comment.id,
    task_key: current.key,
    task_record_id: current.record_id,
    body,
    created_at: comment.created_at,
  }
}
