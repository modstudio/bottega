import { newRecordId } from '../../shared/record/schema.ts'
import { HOSTED_UNREACHABLE_REMEDY, projectMappedToHostedSpace } from './hosted-write-mode.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import { projects } from './projects.ts'
import {
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type HostedPushChange,
  type PushedComment,
  type PushedStatusEvent,
  type PushedTask,
} from './push-contract.ts'
import type { Attribution } from './task-attribution.ts'
import { hostedGetTask, hostedListTasks, isMissingHostedTask } from './task-client.ts'
import type { TaskDocumentSummary } from './task-document.ts'
import { formatTaskDocumentLabel } from './task-document-label.ts'
import { documentRole } from './task-document-role.ts'
import { missingTaskError, type TaskScope } from './task-identity.ts'
import type { TaskRow } from './task-row.ts'
import type { TaskChanges, TaskComment } from './task-types.ts'
import { type HostedTaskWriteOptions, hostedTaskWriteOptions } from './task-write-destination.ts'

export function hostedTaskRow(row: import('./hosted-tasks.ts').HostedTask): TaskRow {
  return {
    record_id: row.id,
    external_id: null,
    key: row.key,
    project: row.project,
    project_record_id: row.projectId ?? projectRecordIdFor(row.project),
    title: row.title,
    status: row.status,
    status_category: row.status_category,
    parent_key: row.parent_key,
    parent_record_id: row.parent_id ?? null,
    body: row.body,
    assignee: row.assignee,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    updated_at: row.updated_at,
    source: row.source,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    next_document_number: row.next_document_number,
    retired_reason: row.retired_reason ?? null,
    revision: row.revision,
  }
}

export function hostedComment(row: import('./hosted-tasks.ts').HostedComment): TaskComment {
  return {
    id: row.id,
    task_key: row.task_key,
    task_record_id: row.task_id ?? '',
    body: row.body,
    created_at: row.created_at,
    actor_user_id: row.actor_user_id ?? null,
    actor_name: row.actor_name ?? null,
    agent: row.agent ?? null,
    run_id: row.run_id ?? null,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    revision: row.revision,
  }
}

function hostedProjects(project?: string) {
  const selected = project ? projects().filter((row) => row.name === project) : projects()
  const hosted = selected.filter((row) => projectMappedToHostedSpace(row.settings.space))
  const undeclared = selected.filter((row) => !projectMappedToHostedSpace(row.settings.space))
  if (project && undeclared.length) hostedTaskWriteOptions(project)
  if (!project && undeclared.length)
    console.error(
      `tasks for projects ${undeclared.map((row) => row.name).join(', ')} were not shown because they have no declared record space`,
    )
  return hosted
}

function hostedProjectSpaces(project?: string, hosted?: HostedTaskWriteOptions) {
  const spaces = new Map<string, ReturnType<typeof hostedTaskWriteOptions>>()
  for (const row of hostedProjects(project)) {
    const options = hostedTaskWriteOptions(row.name, hosted)
    if (!spaces.has(options.recordSpace)) spaces.set(options.recordSpace, options)
  }
  return spaces.values()
}

export async function listHostedTasks(filters: {
  project?: string
  status?: string
  parent?: string
}) {
  const rows = new Map<string, TaskRow>()
  for (const options of hostedProjectSpaces(filters.project)) {
    const page = await hostedListTasks(options, filters)
    for (const task of page.tasks) rows.set(task.id, hostedTaskRow(task))
  }
  return [...rows.values()].sort(
    (left, right) => left.project.localeCompare(right.project) || left.key.localeCompare(right.key),
  )
}

export async function showHostedTask(
  key: string,
  scope: TaskScope,
  hosted?: HostedTaskWriteOptions,
) {
  const found = []
  for (const options of hostedProjectSpaces(scope.project, hosted)) {
    try {
      const detail = await hostedGetTask(scope.recordId ?? key.toUpperCase(), options)
      if (!scope.project || detail.task.project === scope.project) found.push(detail)
    } catch (error) {
      if (!isMissingHostedTask(error)) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message}. ${HOSTED_UNREACHABLE_REMEDY}`)
      }
    }
  }
  if (found.length !== 1) throw missingTaskError(key.toUpperCase())
  const detail = found[0]!
  return {
    task: hostedTaskRow(detail.task),
    comments: detail.comments.map(hostedComment),
    documents: detail.documents.map(
      (row): TaskDocumentSummary => ({
        id: row.id,
        number: row.number!,
        label: formatTaskDocumentLabel(row.task_key, row.number!),
        task_key: row.task_key,
        task_record_id: row.task_id ?? '',
        role: documentRole(row.role),
        title: row.title,
        updated_at: row.updated_at,
        body: row.body,
        version: row.version,
        created_at: row.created_at,
      }),
    ),
  }
}

function pushedTask(current: TaskRow, changes: TaskChanges, at: string): PushedTask {
  const category =
    changes.status === undefined
      ? current.status_category
      : (changes.status as TaskRow['status_category'])
  return {
    id: current.record_id,
    key: current.key,
    project: current.project,
    project_name: current.project,
    projectId: current.project_record_id ?? projectRecordIdFor(current.project),
    title: changes.title ?? current.title,
    status: category,
    status_category: category,
    parent_key: changes.parent === undefined ? current.parent_key : changes.parent,
    body: changes.body === undefined ? current.body : changes.body,
    assignee: changes.assignee === undefined ? current.assignee : changes.assignee,
    opened_at: current.opened_at,
    closed_at: category === 'done' ? (current.closed_at ?? at) : null,
    source: current.source,
    first_seen: current.first_seen,
    last_seen: at,
    created_at: current.first_seen,
    updated_at: at,
    deleted_at: null,
    next_document_number: current.next_document_number,
    retired_reason: current.retired_reason,
    revision: current.revision,
  }
}

function taskPatchGuards(current: TaskRow, changes: TaskChanges) {
  return {
    ...(changes.status !== undefined
      ? { status: current.status, status_category: current.status_category }
      : {}),
    ...(changes.parent !== undefined ? { parent_key: current.parent_key } : {}),
    ...(changes.assignee !== undefined ? { assignee: current.assignee } : {}),
  }
}

function taskChangeFields(changes: TaskChanges): string[] {
  return [
    ...(changes.title !== undefined ? ['title'] : []),
    ...(changes.status !== undefined ? ['status', 'status_category'] : []),
    ...(changes.parent !== undefined ? ['parent_key'] : []),
    ...(changes.body !== undefined ? ['body'] : []),
    ...(changes.assignee !== undefined ? ['assignee'] : []),
  ]
}

export function hostedTaskBatch(input: {
  current: TaskRow
  changes: TaskChanges
  category: TaskRow['status_category']
  at: string
  attribution: Attribution
  expectedRevision?: number
}): HostedPushChange[][] {
  const fields = taskChangeFields(input.changes)
  const guards = taskPatchGuards(input.current, input.changes)
  const task: HostedPushChange = {
    table: HOSTED_TASK_TABLE,
    id: input.current.record_id,
    op: 'upsert',
    row: pushedTask(input.current, input.changes, input.at),
    fields,
    ...(input.expectedRevision === undefined ? {} : { expected_revision: input.expectedRevision }),
    ...(Object.keys(guards).length ? { from: guards } : {}),
  }
  if (input.changes.status === undefined || input.current.status_category === input.category)
    return [[task]]
  const event = pushedStatusEvent(input.current, input.category!, input.at, input.attribution)
  return [[task], [{ table: HOSTED_STATUS_EVENT_TABLE, id: event.id, op: 'upsert', row: event }]]
}

function pushedStatusEvent(
  current: TaskRow,
  next: string,
  at: string,
  attribution: Attribution,
): PushedStatusEvent {
  return {
    id: newRecordId(),
    task_key: current.key,
    task_id: current.record_id,
    project_name: current.project,
    projectId: current.project_record_id ?? projectRecordIdFor(current.project),
    at,
    from_status: current.status_category,
    to_status: next,
    created_at: at,
    updated_at: at,
    deleted_at: null,
    actor_user_id: attribution.actorUserId,
    actor_name: attribution.actorName,
    agent: attribution.agent,
    run_id: attribution.runId,
  }
}

export function pushedComment(
  current: TaskRow,
  body: string,
  at: string,
  attribution: Attribution,
): PushedComment {
  return {
    id: newRecordId(),
    task_key: current.key,
    task_id: current.record_id,
    project_name: current.project,
    projectId: current.project_record_id ?? projectRecordIdFor(current.project),
    body,
    created_at: at,
    updated_at: at,
    deleted_at: null,
    actor_user_id: attribution.actorUserId,
    actor_name: attribution.actorName,
    agent: attribution.agent,
    run_id: attribution.runId,
  }
}

export function pushedCommentRevision(
  current: TaskRow,
  comment: TaskComment,
  changes: Partial<Pick<PushedComment, 'body' | 'deleted_at'>>,
  at: string,
): PushedComment {
  return {
    ...comment,
    id: comment.id,
    task_id: current.record_id,
    project_name: current.project,
    projectId: current.project_record_id ?? projectRecordIdFor(current.project),
    ...changes,
    updated_at: at,
  }
}
