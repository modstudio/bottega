import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { missingTaskRecordLine } from '../../shared/task-missing.ts'
import { type StatusCategory, TASK_STATUSES } from '../../shared/tracker-status-category.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import { duplicateScore } from './duplicate-score.ts'
import { sendHostedChanges } from './hosted-change-sender.ts'
import { applyHostedWriteLocally } from './hosted-local-apply.ts'
import type { HostedTaskLookupRow } from './hosted-tasks.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import { hostedWriteMode, type TaskWriteMode } from './hosted-write-mode.ts'
import { type BranchPruneResult, classifyTaskBranches } from './orch.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import { projects } from './projects.ts'
import type { PushedComment } from './push-contract.ts'
import type { Attribution } from './task-attribution.ts'
import { commentAuthorDecision, UNATTRIBUTED } from './task-attribution.ts'
import { cacheCreatedHostedTask } from './task-cache.ts'
import { hostedCreateTask, hostedLookupTasks } from './task-client.ts'
import { decideTaskClose, landingCheck } from './task-close-decision.ts'
import { sendTaskCommentRecord } from './task-comment-record.ts'
import { type TaskDetail, taskBodyVersion } from './task-detail.ts'
import type { TaskDocumentSummary } from './task-document-types.ts'
import {
  hostedComment,
  hostedTaskBatch,
  hostedTaskRow,
  listHostedTasks,
  pushedComment,
  pushedCommentRevision,
  showHostedTask,
} from './task-hosted-record.ts'
import {
  missingTaskError,
  resolveTask,
  type TaskScope,
  taskByRecordId,
  taskRecordId,
  taskRecordIdFor,
} from './task-identity.ts'
import { listLocalTasks, lookupLocalTasks, showLocalTask } from './task-local-read.ts'
import { taskRecordFromRows } from './task-record.ts'
import type { TaskRow } from './task-row.ts'
import type { TaskChanges, TaskComment } from './task-types.ts'
import {
  type HostedTaskWriteOptions,
  hostedTaskChangeSendOptions,
  hostedTaskWriteOptions,
  registeredTaskProject,
  taskWriteMode,
} from './task-write-destination.ts'
import { trackerCapabilities } from './tracker-capabilities.ts'
import { taskCreationDestination } from './tracker-new.ts'

export { listLocalTasks } from './task-local-read.ts'
export type { TaskChanges, TaskComment } from './task-types.ts'

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

export class StaleTaskBodyError extends Error {
  readonly expectedVersion: string
  readonly currentVersion: string

  constructor(key: string, expectedVersion: string, currentVersion: string) {
    super(
      `task ${key} body changed since version ${expectedVersion}; current version is ${currentVersion}`,
    )
    this.name = 'StaleTaskBodyError'
    this.expectedVersion = expectedVersion
    this.currentVersion = currentVersion
  }
}

// Provisional, measured against the reports that introduced duplicate detection:
// known duplicates scored at least 0.227, while the best unrelated result across
// those searches scored 0.151.
const DUPLICATE_THRESHOLD = 0.2
const DUPLICATE_LIMIT = 3

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

export function localTaskStatusCategory(value: string | undefined): StatusCategory {
  const candidate = value ?? 'open'
  if (!(TASK_STATUSES as readonly string[]).includes(candidate)) {
    throw new Error(`invalid status '${candidate}': expected ${TASK_STATUSES.join('|')}`)
  }
  return candidate as StatusCategory
}

const status = localTaskStatusCategory

const registeredProject = registeredTaskProject

function assertParent(key: string | null | undefined, project?: string) {
  if (!key) return null
  return resolveTask(db(), key, project)
}

/** Check, allocate, insert, and record an override under one serialized write transaction. */
type HostedOptions = HostedTaskWriteOptions
const hostedOptionsForProject = hostedTaskWriteOptions
const hostedSendOptionsForTask = hostedTaskChangeSendOptions

type DoneTransitionOptions = {
  abandonReason?: string
  classify?: (project: string, key: string) => Promise<BranchPruneResult>
  comment?: typeof commentTask
  externalAbandonRefusal?: string
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
  attribution: Attribution,
) {
  if (!next || next === task.status_category) return null
  const id = newRecordId()
  conn
    .query(
      `INSERT OR IGNORE INTO task_status_event(record_id,task_key,task_record_id,at,from_status,to_status,
       actor_user_id,actor_name,agent,run_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      task.key,
      task.record_id,
      at,
      task.status_category,
      next,
      attribution.actorUserId,
      attribution.actorName,
      attribution.agent,
      attribution.runId,
    )
  return id
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
    attribution?: Attribution
  } = {},
): TaskRow {
  const project = registeredProject(input.project)
  if (taskCreationDestination(project) === 'tracker')
    throw new Error(
      `project '${input.project}' owns task creation in its tracker; use ${PLATFORM_SLUG} task new --project ${input.project} --title "..."`,
    )
  const prefix = project.settings.keyPrefixes?.[0]
  if (!prefix) {
    throw new Error(
      `project '${input.project}' has no key prefix; set one with ` +
        `${PLATFORM_SLUG} project set ${input.project} --settings '{"keyPrefixes":["ABC"]}'`,
    )
  }
  const category = status(input.status)
  const parent = input.parent?.toUpperCase()
  const parentRecordId = parent ? taskRecordIdFor(conn, parent, input.project) : null
  if (parent && !parentRecordId) throw missingTaskError(parent)
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
      (record_id,key,project,project_record_id,title,status,status_category,parent_key,parent_record_id,body,assignee,
       opened_at,closed_at,updated_at,source,first_seen,last_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'local',?,?)`,
    )
    .run(
      recordId,
      key,
      input.project,
      projectRecordIdFor(input.project),
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
        `INSERT INTO task_comment (record_id,task_key,task_record_id,body,created_at,updated_at,
         actor_user_id,actor_name,agent,run_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        newRecordId(),
        key,
        recordId,
        options.allowDuplicateReason,
        updatedAt,
        updatedAt,
        options.attribution?.actorUserId ?? null,
        options.attribution?.actorName ?? null,
        options.attribution?.agent ?? null,
        options.attribution?.runId ?? null,
      )
  }
  const row = conn.query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id = ?`).get(recordId)
  if (!row) throw new Error(missingTaskRecordLine(recordId))
  return row
}

function writeLocalComment(
  conn: Database,
  task: Pick<TaskRow, 'key' | 'record_id'>,
  body: string,
  at: string,
  attribution: Attribution,
  recordId = newRecordId(),
): TaskComment {
  conn
    .query(
      `INSERT INTO task_comment (record_id,task_key,task_record_id,body,created_at,updated_at,
       actor_user_id,actor_name,agent,run_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      recordId,
      task.key,
      task.record_id,
      body,
      at,
      at,
      attribution.actorUserId,
      attribution.actorName,
      attribution.agent,
      attribution.runId,
    )
  conn
    .query(`UPDATE task SET updated_at = ?, last_seen = ? WHERE record_id = ?`)
    .run(at, at, task.record_id)
  return {
    id: recordId,
    task_key: task.key,
    task_record_id: task.record_id,
    body,
    created_at: at,
    actor_user_id: attribution.actorUserId,
    actor_name: attribution.actorName,
    agent: attribution.agent,
    run_id: attribution.runId,
    updated_at: at,
    deleted_at: null,
  }
}

function localTaskInTransaction(conn: Database, key: string, project: string): TaskRow {
  const upper = key.toUpperCase()
  const task = conn
    .query<TaskRow, [string, string]>(
      `SELECT * FROM task WHERE project = ? AND key = ? COLLATE NOCASE`,
    )
    .get(project, upper)
  if (task?.source !== 'local')
    throw new Error(
      `no local task ${upper} in project ${project}; run \`${PLATFORM_SLUG} task list --project ${project}\``,
    )
  return task
}

export function attachLocalTaskEvidenceInTransaction(
  conn: Database,
  key: string,
  project: string,
  body: string,
  at: string,
): TaskComment {
  const task = localTaskInTransaction(conn, key, project)
  return writeLocalComment(conn, task, body, at, UNATTRIBUTED)
}

type NoteRelinkCommentInput = Record<
  'project' | 'noteLabel' | 'previousTask' | 'targetTask' | 'reason' | 'at',
  string
>

function prepareNoteRelinkComments(conn: Database, input: NoteRelinkCommentInput) {
  const target = localTaskInTransaction(conn, input.targetTask, input.project)
  const previous = localTaskInTransaction(conn, input.previousTask, input.project)
  const row = (task: TaskRow, body: string): PushedComment => ({
    id: newRecordId(),
    task_key: task.key,
    task_id: task.record_id,
    project_name: task.project,
    projectId: task.project_record_id,
    body,
    created_at: input.at,
    updated_at: input.at,
    deleted_at: null,
  })
  return {
    targetTaskRecordId: target.record_id,
    comments: [
      row(target, `note ${input.noteLabel} relinked from ${input.previousTask}: ${input.reason}`),
      ...(previous.record_id === target.record_id
        ? []
        : [row(previous, `note ${input.noteLabel} relinked to ${target.key}: ${input.reason}`)]),
    ],
  }
}

function writePreparedNoteRelinkComments(
  conn: Database,
  prepared: ReturnType<typeof prepareNoteRelinkComments>,
): void {
  for (const comment of prepared.comments)
    writeLocalComment(
      conn,
      { key: comment.task_key, record_id: comment.task_id! },
      comment.body,
      comment.created_at,
      UNATTRIBUTED,
      comment.id,
    )
}

export function recordNoteRelinkCommentsInTransaction(
  conn: Database,
  input: NoteRelinkCommentInput | ReturnType<typeof prepareNoteRelinkComments>,
  record = true,
) {
  const prepared = 'comments' in input ? input : prepareNoteRelinkComments(conn, input)
  if (record) writePreparedNoteRelinkComments(conn, prepared)
  return prepared
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
    attribution?: Attribution
  } = {},
): Promise<TaskRow> {
  if (!input.title.trim()) throw new Error('task title is required')
  const project = registeredProject(input.project)
  if (taskCreationDestination(project) === 'tracker')
    throw new Error(
      `project '${input.project}' owns task creation in its tracker; use ${PLATFORM_SLUG} task new --project ${input.project} --title "..."`,
    )
  const mode = writeMode(input.project, options.hosted)
  if (mode === 'local-authoritative') {
    return writeTransaction((conn) => createLocalTaskInTransaction(conn, input, options))
  }
  const prefix = project.settings.keyPrefixes?.[0]
  if (!prefix) {
    throw new Error(
      `project '${input.project}' has no key prefix; set one with ` +
        `${PLATFORM_SLUG} project set ${input.project} --settings '{"keyPrefixes":["ABC"]}'`,
    )
  }
  const category = status(input.status)
  const parent = input.parent?.toUpperCase()
  assertParent(parent, input.project)
  void prefix
  const candidates = duplicateCandidates(await listTasks({ project: input.project }), input.title)
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
      projectId: project.record_id,
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
  const commentAt = nowIso()
  const duplicateComment = options.allowDuplicateReason
    ? pushedComment(
        hostedTaskRow(hosted),
        options.allowDuplicateReason,
        commentAt,
        options.attribution ?? UNATTRIBUTED,
      )
    : null
  if (duplicateComment) await sendTaskCommentRecord(duplicateComment, { hosted: options.hosted })
  const applied = applyHostedWriteLocally(
    `${hosted.key} was created in the hosted record; its local copy will arrive on the next record pull`,
    () =>
      writeTransaction((conn) => {
        cacheCreatedHostedTask(conn, hosted)
        if (duplicateComment)
          writeLocalComment(
            conn,
            { key: hosted.key, record_id: hosted.id },
            duplicateComment.body,
            commentAt,
            options.attribution ?? UNATTRIBUTED,
            duplicateComment.id,
          )
      }),
  )
  return applied
    ? (
        await showHostedTask(
          hosted.key,
          { project: input.project, recordId: hosted.id },
          options.hosted,
        )
      ).task
    : hostedTaskRow(hosted)
}

export async function listTasks(
  filters: { project?: string; status?: string; parent?: string } = {},
): Promise<TaskRow[]> {
  if (hostedWriteMode(resolveHostedUrl()) !== 'hosted-configured') return listLocalTasks(filters)
  if (filters.status) status(filters.status)
  return listHostedTasks(filters)
}

export async function lookupTasks(project: string, keys: string[]): Promise<HostedTaskLookupRow[]> {
  if (hostedWriteMode(resolveHostedUrl()) === 'hosted-configured')
    return hostedLookupTasks(project, keys, hostedTaskWriteOptions(project))
  return lookupLocalTasks(project, keys)
}

export async function showTask(
  key: string,
  scope: TaskScope = {},
): Promise<{ task: TaskRow; comments: TaskComment[]; documents: TaskDocumentSummary[] }> {
  return readCurrentTask(key, scope)
}

async function readCurrentTask(key: string, scope: TaskScope, hosted?: HostedOptions) {
  if (hostedWriteMode(hosted?.baseUrl ?? resolveHostedUrl()) !== 'hosted-configured')
    return showLocalTask(key, scope)
  return showHostedTask(key, scope, hosted)
}

function hostedExpectedRevisionRefusal(subject: string, taskKey: string): Error {
  return new Error(
    `${subject} requires --expect <revision> from \`${PLATFORM_SLUG} task show ${taskKey}\``,
  )
}

/** The complete read-only task record used by the dashboard detail sheet. */
export async function taskRecord(
  key: string,
  scope: TaskScope = {},
  readerUserId: string | null = null,
): Promise<TaskDetail> {
  return taskRecordFromRows(await readCurrentTask(key, scope), readerUserId)
}

export async function setTaskBody(
  key: string,
  scope: TaskScope,
  body: string,
  expectedVersion: string,
  options: { hosted?: HostedOptions } = {},
): Promise<TaskRow> {
  const upper = key.toUpperCase()
  if (hostedWriteMode(options.hosted?.baseUrl ?? resolveHostedUrl()) === 'hosted-configured') {
    const current = (await readCurrentTask(upper, scope, options.hosted)).task
    const project = projects().find((candidate) => candidate.name === current.project) ?? null
    const capability = trackerCapabilities({ source: current.source, project }).setBody
    if (!capability.allowed) throw new Error(capability.reason)
    const at = nowIso()
    await sendHostedChanges(
      'the record',
      hostedTaskBatch({
        current,
        changes: { body },
        category: current.status_category,
        at,
        attribution: UNATTRIBUTED,
        expectedRevision: Number(expectedVersion),
      }),
      hostedSendOptionsForTask(current.key, current.project, options.hosted),
    )
    return (
      await showHostedTask(
        upper,
        { project: current.project, recordId: current.record_id },
        options.hosted,
      )
    ).task
  }
  const recordId = taskRecordId(upper, scope)
  const initial = taskByRecordId<TaskRow>(recordId)
  const initialProject = projects().find((candidate) => candidate.name === initial.project) ?? null
  const initialCapability = trackerCapabilities({
    source: initial.source,
    project: initialProject,
  }).setBody
  if (!initialCapability.allowed) throw new Error(initialCapability.reason)
  writeMode(initial.project, options.hosted)
  const at = nowIso()
  const result = writeTransaction((conn) => {
    const current = conn
      .query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id=?`)
      .get(recordId)
    if (!current) throw missingTaskError(upper)
    const project = projects().find((candidate) => candidate.name === current.project) ?? null
    const capability = trackerCapabilities({ source: current.source, project }).setBody
    if (!capability.allowed) throw new Error(capability.reason)
    const currentVersion = taskBodyVersion(current.body)
    if (currentVersion !== expectedVersion) {
      throw new StaleTaskBodyError(current.key, expectedVersion, currentVersion)
    }
    return applyLocalTaskPatch(conn, recordId, { body }, { force: true }, at, UNATTRIBUTED)
  })
  return result
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
  changes: TaskChanges,
  options: { force?: boolean },
  at: string,
  attribution: Attribution,
): TaskRow {
  const current = conn
    .query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id = ?`)
    .get(recordId)
  if (!current) throw new Error(missingTaskRecordLine(recordId))
  if (current.source !== 'local') throw new Error(`task ${current.key} is not local`)
  assertLocalTaskBodyOverwrite(current, changes.body, options.force)
  const category = changes.status === undefined ? current.status_category : status(changes.status)
  const parent =
    changes.parent === undefined ? current.parent_key : (changes.parent?.toUpperCase() ?? null)
  const parentRecordId = parent ? taskRecordIdFor(conn, parent, current.project) : null
  if (parent && !parentRecordId) throw missingTaskError(parent)
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
  recordLocalStatusChange(conn, current, category, at, attribution)
  const row = conn.query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id = ?`).get(recordId)
  if (!row) throw new Error(missingTaskRecordLine(recordId))
  return row
}

export async function prepareDoneTransition(
  current: TaskRow,
  attribution: Attribution,
  options: { hosted?: HostedOptions } & DoneTransitionOptions,
): Promise<void> {
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
  if (
    current.source !== 'local' &&
    classification.available &&
    classification.unlanded.length > 0 &&
    options.externalAbandonRefusal
  ) {
    if (options.abandonReason) throw new Error(options.externalAbandonRefusal)
    if (decision.action === 'refuse' && decision.unlanded) {
      throw new Error(
        `${decision.unlanded.facts}\nLand each branch or delete it, then retry.\n${options.externalAbandonRefusal}`,
      )
    }
  }
  if (decision.action === 'refuse') throw new Error(decision.reason)
  if (decision.comment !== null) {
    await (options.comment ?? commentTask)(
      current.key,
      { recordId: current.record_id },
      decision.comment,
      attribution,
      { hosted: options.hosted },
    )
  }
}

export async function setTask(
  key: string,
  scope: TaskScope,
  changes: TaskChanges,
  attribution: Attribution,
  options: {
    force?: boolean
    expectedRevision?: number
    hosted?: HostedOptions
  } & DoneTransitionOptions = {},
): Promise<TaskRow> {
  const upper = key.toUpperCase()
  const current = (await readCurrentTask(upper, scope, options.hosted)).task
  if (current.source !== 'local') throw new Error(`task ${upper} is not local`)
  assertLocalTaskBodyOverwrite(current, changes.body, options.force)
  const category = changes.status === undefined ? current.status_category : status(changes.status)
  const parent =
    changes.parent === undefined ? current.parent_key : (changes.parent?.toUpperCase() ?? null)
  assertParent(parent, current.project)
  if (category === 'done' && current.status_category !== 'done') {
    await prepareDoneTransition(current, attribution, options)
  }
  const mode = writeMode(current.project, options.hosted)
  const at = nowIso()
  const hosted = mode === 'hosted-configured'
  if (hosted) {
    if (
      (changes.title !== undefined || changes.body !== undefined) &&
      options.expectedRevision === undefined
    )
      throw hostedExpectedRevisionRefusal('task text replacement', current.key)
    const batch = hostedTaskBatch({
      current,
      changes: changes.parent === undefined ? changes : { ...changes, parent },
      category,
      at,
      attribution,
      expectedRevision: options.expectedRevision,
    })
    await sendHostedChanges(
      'the record',
      batch,
      hostedSendOptionsForTask(current.key, current.project, options.hosted),
    )
    return (
      await showHostedTask(
        current.key,
        { project: current.project, recordId: current.record_id },
        options.hosted,
      )
    ).task
  }
  const result = writeTransaction((conn) => {
    return applyLocalTaskPatch(conn, current.record_id, changes, options, at, attribution)
  })
  return result
}

export async function closeTask(
  key: string,
  scope: TaskScope,
  attribution: Attribution,
  options: { hosted?: HostedOptions } & DoneTransitionOptions = {},
) {
  const current = (await readCurrentTask(key, scope, options.hosted)).task
  if (current.source !== 'local') throw new Error(`task ${current.key} is not local`)
  if (current.status_category !== 'done') await prepareDoneTransition(current, attribution, options)
  const mode = writeMode(current.project, options.hosted)
  const hosted = mode === 'hosted-configured'
  const at = nowIso()
  if (hosted) {
    await sendHostedChanges(
      'the record',
      hostedTaskBatch({
        current,
        changes: { status: 'done' },
        category: 'done',
        at,
        attribution,
      }),
      hostedSendOptionsForTask(current.key, current.project, options.hosted),
    )
    return (
      await showHostedTask(
        current.key,
        { project: current.project, recordId: current.record_id },
        options.hosted,
      )
    ).task
  }
  const result = writeTransaction((conn) => {
    const row = conn
      .query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id = ?`)
      .get(current.record_id)
    if (!row) throw new Error(missingTaskRecordLine(current.record_id))
    conn
      .query(
        `UPDATE task SET status = 'done', status_category = 'done',
                         closed_at = COALESCE(closed_at, ?), updated_at = ?, last_seen = ?
           WHERE record_id = ?`,
      )
      .run(at, at, at, row.record_id)
    recordLocalStatusChange(conn, row, 'done', at, attribution)
    const closed = conn
      .query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id = ?`)
      .get(row.record_id)
    if (!closed) throw new Error(missingTaskRecordLine(row.record_id))
    return closed
  })
  return result
}

export async function commentTask(
  key: string,
  scope: TaskScope,
  body: string,
  attribution: Attribution,
  options: { hosted?: HostedOptions } = {},
): Promise<TaskComment> {
  const upper = key.toUpperCase()
  const current = (await readCurrentTask(upper, scope, options.hosted)).task
  if (current.source !== 'local') throw new Error(`task ${upper} is not local`)
  const mode = writeMode(current.project, options.hosted)
  const hosted = mode === 'hosted-configured'
  const at = nowIso()
  if (hosted) {
    const comment = pushedComment(current, body, at, attribution)
    await sendTaskCommentRecord(comment, { hosted: options.hosted })
    return { ...hostedComment(comment), revision: 1 }
  }
  const result = writeTransaction((conn) => {
    const row = conn
      .query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id = ?`)
      .get(current.record_id)
    if (!row) throw new Error(missingTaskRecordLine(current.record_id))
    if (row.source !== 'local') throw new Error(`task ${row.key} is not local`)
    return writeLocalComment(conn, row, body, at, attribution)
  })
  return result
}

function editableComment(
  conn: Database,
  task: TaskRow,
  commentId: string,
  attribution: Attribution,
  mode: TaskWriteMode,
): TaskComment {
  const project = projects().find((candidate) => candidate.name === task.project) ?? null
  const capability = trackerCapabilities({ source: task.source, project }).comment
  if (!capability.allowed) throw new Error(capability.reason)
  const comment = conn
    .query<TaskComment, [string, string]>(
      `SELECT record_id id,task_key,task_record_id,body,created_at,updated_at,deleted_at,
       actor_user_id,actor_name,agent,run_id FROM task_comment
       WHERE record_id=? AND task_record_id=?`,
    )
    .get(commentId, task.record_id)
  if (!comment || comment.deleted_at)
    throw new Error(
      `comment ${commentId} was not found; run ${PLATFORM_SLUG} task show ${task.key}`,
    )
  const author = commentAuthorDecision(mode, attribution.actorUserId, comment.actor_user_id)
  if (!author.allowed) throw new Error(`comment ${commentId} ${author.reason}`)
  return comment
}

export async function editTaskComment(
  key: string,
  scope: TaskScope,
  commentId: string,
  body: string,
  attribution: Attribution,
  options: { hosted?: HostedOptions; expectedRevision?: number } = {},
): Promise<TaskComment> {
  if (!body.trim()) throw new Error('comment body is required; pass non-empty text')
  const detail = await readCurrentTask(key, scope, options.hosted)
  const current = detail.task
  const hosted = writeMode(current.project, options.hosted) === 'hosted-configured'
  const at = nowIso()
  if (hosted) {
    if (options.expectedRevision === undefined)
      throw hostedExpectedRevisionRefusal(`comment ${commentId} edit`, current.key)
    const comment = detail.comments.find((row) => row.id === commentId)
    if (!comment)
      throw new Error(
        `comment ${commentId} was not found; run ${PLATFORM_SLUG} task show ${current.key}`,
      )
    const author = commentAuthorDecision(
      'hosted-configured',
      attribution.actorUserId,
      comment.actor_user_id,
    )
    if (!author.allowed) throw new Error(`comment ${commentId} ${author.reason}`)
    const row = pushedCommentRevision(current, comment, { body }, at)
    await sendTaskCommentRecord(row, {
      hosted: options.hosted,
      fields: ['body', 'updated_at'],
      expected_revision: options.expectedRevision,
    })
    return { ...comment, body, updated_at: at, revision: options.expectedRevision + 1 }
  }
  const result = writeTransaction((conn) => {
    const task = conn
      .query<TaskRow, [string]>('SELECT * FROM task WHERE record_id=?')
      .get(current.record_id)
    if (!task) throw missingTaskError(key.toUpperCase())
    const comment = editableComment(
      conn,
      task,
      commentId,
      attribution,
      hosted ? 'hosted-configured' : 'local-authoritative',
    )
    if (comment.body === body)
      throw new Error('comment body is unchanged; change the text before saving')
    conn
      .query('UPDATE task_comment SET body=?,updated_at=? WHERE record_id=?')
      .run(body, at, commentId)
    return { ...comment, body, updated_at: at }
  })
  return result
}

export async function deleteTaskComment(
  key: string,
  scope: TaskScope,
  commentId: string,
  attribution: Attribution,
  options: { hosted?: HostedOptions; expectedRevision?: number } = {},
): Promise<void> {
  const detail = await readCurrentTask(key, scope, options.hosted)
  const current = detail.task
  const hosted = writeMode(current.project, options.hosted) === 'hosted-configured'
  const at = nowIso()
  if (hosted) {
    if (options.expectedRevision === undefined)
      throw hostedExpectedRevisionRefusal(`comment ${commentId} deletion`, current.key)
    const comment = detail.comments.find((row) => row.id === commentId)
    if (!comment)
      throw new Error(
        `comment ${commentId} was not found; run ${PLATFORM_SLUG} task show ${current.key}`,
      )
    const author = commentAuthorDecision(
      'hosted-configured',
      attribution.actorUserId,
      comment.actor_user_id,
    )
    if (!author.allowed) throw new Error(`comment ${commentId} ${author.reason}`)
    const row = pushedCommentRevision(current, comment, { deleted_at: at }, at)
    await sendTaskCommentRecord(row, {
      hosted: options.hosted,
      fields: ['updated_at', 'deleted_at'],
      expected_revision: options.expectedRevision,
    })
    return
  }
  writeTransaction((conn) => {
    const task = conn
      .query<TaskRow, [string]>('SELECT * FROM task WHERE record_id=?')
      .get(current.record_id)
    if (!task) throw missingTaskError(key.toUpperCase())
    editableComment(
      conn,
      task,
      commentId,
      attribution,
      hosted ? 'hosted-configured' : 'local-authoritative',
    )
    conn
      .query('UPDATE task_comment SET updated_at=?,deleted_at=? WHERE record_id=?')
      .run(at, at, commentId)
  })
}
