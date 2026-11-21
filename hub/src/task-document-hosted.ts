import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { db } from './db.ts'
import { projects } from './projects.ts'
import { formatTaskDocumentLabel, parseTaskDocumentLabel } from './task-document-label.ts'
import type { TaskDocument, TaskDocumentSummary } from './task-document-types.ts'
import { showHostedTask } from './task-hosted-record.ts'
import { type TaskScope, taskKeyPrefix } from './task-identity.ts'
import { type HostedTaskWriteOptions, taskWriteDecision } from './task-write-destination.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type HostedDocumentContext = {
  document: TaskDocument
  project: string
}

function usesHostedRecord(project: string, hosted?: HostedTaskWriteOptions): boolean {
  return taskWriteDecision(project, hosted).mode === 'hosted-configured'
}

function projectForTaskKey(taskKey: string, scope: TaskScope): string {
  if (scope.project) return scope.project
  const prefix = taskKeyPrefix(taskKey)
  const matches = projects().filter((project) =>
    project.settings.keyPrefixes?.some((candidate) => candidate.toUpperCase() === prefix),
  )
  if (matches.length === 1) return matches[0]!.name
  throw new Error(
    `cannot determine the project for task ${taskKey}; pass --project <project> or register its key prefix`,
  )
}

function requiredHostedDocument(document: TaskDocumentSummary): TaskDocument {
  if (
    document.body === undefined ||
    document.version === undefined ||
    document.created_at === undefined
  )
    throw new Error(`hosted task document ${document.id} is incomplete; retry the record read`)
  return {
    ...document,
    body: document.body,
    version: document.version,
    created_at: document.created_at,
  }
}

async function hostedDocumentForTask(
  taskKey: string,
  project: string,
  match: (document: TaskDocumentSummary) => boolean,
  missing: string,
  hosted?: HostedTaskWriteOptions,
): Promise<HostedDocumentContext> {
  const detail = await showHostedTask(taskKey, { project }, hosted)
  const document = detail.documents.find(match)
  if (!document) throw new Error(missing)
  return { document: requiredHostedDocument(document), project }
}

export async function resolveHostedTaskDocument(
  value: string,
  scope: TaskScope = {},
  hosted?: HostedTaskWriteOptions,
): Promise<HostedDocumentContext | null> {
  if (!UUID.test(value)) {
    const label = parseTaskDocumentLabel(value)
    const project = projectForTaskKey(label.taskKey, scope)
    if (!usesHostedRecord(project, hosted)) return null
    return hostedDocumentForTask(
      label.taskKey,
      project,
      (document) => document.number === label.number,
      `no task document ${formatTaskDocumentLabel(label.taskKey, label.number)}`,
      hosted,
    )
  }

  const id = value.toLowerCase()
  const mirror = db()
    .query<{ task_key: string; project: string }, [string]>(
      `SELECT d.task_key,t.project FROM task_document d
       JOIN task t ON t.record_id=d.task_record_id WHERE d.record_id=?`,
    )
    .get(id)
  if (!mirror) {
    const possibleProjects = scope.project
      ? projects().filter((project) => project.name === scope.project)
      : projects()
    if (
      possibleProjects.length > 0 &&
      possibleProjects.every((project) => !usesHostedRecord(project.name, hosted))
    )
      return null
    throw new Error(
      `use the label <KEY>/<n>; this machine has not pulled document ${id}. Run \`${PLATFORM_SLUG} task doc list <KEY>\` to find the label`,
    )
  }
  if (!usesHostedRecord(mirror.project, hosted)) return null
  return hostedDocumentForTask(
    mirror.task_key,
    mirror.project,
    (document) => document.id === id,
    `no task document ${id}`,
    hosted,
  )
}

export async function resolveHostedTaskDocuments(
  key: string,
  scope: TaskScope = {},
  hosted?: HostedTaskWriteOptions,
): Promise<TaskDocumentSummary[] | null> {
  const upper = key.toUpperCase()
  const project = projectForTaskKey(upper, scope)
  if (!usesHostedRecord(project, hosted)) return null
  return (await showHostedTask(upper, { project }, hosted)).documents
}
