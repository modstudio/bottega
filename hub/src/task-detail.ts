import { createHash } from 'node:crypto'
import type { Measures } from './measures.ts'
import { mayChangeComment } from './task-attribution.ts'
import type { Capabilities } from './tracker-capabilities.ts'

export type TaskDetail = {
  task: {
    key: string
    recordId: string
    project: string
    title: string | null
    status: string | null
    statusCategory: string | null
    parentKey: string | null
    body: string | null
    assignee: string | null
    source: string
    sourceProtocol: string | null
    updatedAt: string | null
    spaceName: string | null
  }
  bodyVersion: string
  comments: {
    id: string
    body: string
    createdAt: string
    actorName: string | null
    agent: string | null
    updatedAt: string | null
    canEdit: boolean
    canDelete: boolean
  }[]
  documents: {
    id: string
    number: number
    label: string
    role: string | null
    title: string
    body: string
    version: string
    updatedAt: string
  }[]
  statusEvents: {
    id: string
    at: string
    fromStatus: string | null
    toStatus: string
    actorName: string | null
    agent: string | null
  }[]
  runs: {
    id: string | null
    source: string | null
    agent: string | null
    job: string | null
    startedAt: string
    endedAt: string
    running: boolean
  }[]
  measures: Measures | null
  measureCoverage: { hasRecordedTime: boolean; from: string; to: string } | null
  capabilities: Pick<
    Capabilities,
    'setTitle' | 'setStatus' | 'setBody' | 'comment' | 'documents' | 'statusVocabulary'
  >
}

/** A content digest is the opaque compare-and-swap token for task bodies. */
export const taskBodyVersion = (body: string | null): string =>
  createHash('sha256')
    .update(body === null ? 'null\0' : `text\0${body}`)
    .digest('hex')

export type LocalTaskDetailRows = {
  task: {
    record_id: string
    key: string
    project: string
    title: string | null
    status: string | null
    status_category: string | null
    parent_key: string | null
    body: string | null
    assignee: string | null
    source: string
    source_protocol: string | null
    updated_at: string | null
  }
  comments: {
    id: string
    body: string
    created_at: string
    updated_at: string | null
    actor_user_id: string | null
    actor_name: string | null
    agent: string | null
  }[]
  documents: Array<{
    id: string
    number: number
    label: string
    role: string | null
    title: string
    body: string
    version: string
    updated_at: string
  }>
  statusEvents: Array<{
    id: string
    at: string
    from_status: string | null
    to_status: string
    actor_name: string | null
    agent: string | null
  }>
  runs: Array<{
    id: string | number | null
    source: string | null
    agent: string | null
    job: string | null
    started_at: string
    ended_at: string
    running: boolean
  }>
  capabilities: TaskDetail['capabilities']
}

export function localTaskDetail(
  rows: LocalTaskDetailRows,
  readerUserId: string | null = null,
): TaskDetail {
  const task = rows.task
  return {
    task: {
      key: task.key,
      recordId: task.record_id,
      project: task.project,
      title: task.title,
      status: task.status,
      statusCategory: task.status_category,
      parentKey: task.parent_key,
      body: task.body,
      assignee: task.assignee,
      source: task.source,
      sourceProtocol: task.source_protocol,
      updatedAt: task.updated_at,
      spaceName: null,
    },
    bodyVersion: taskBodyVersion(task.body),
    comments: rows.comments.map((row) => ({
      id: row.id,
      body: row.body,
      createdAt: row.created_at,
      actorName: row.actor_name,
      agent: row.agent,
      updatedAt: row.updated_at,
      canEdit:
        rows.capabilities.comment.allowed && mayChangeComment(row.actor_user_id, readerUserId),
      canDelete:
        rows.capabilities.comment.allowed && mayChangeComment(row.actor_user_id, readerUserId),
    })),
    documents: rows.documents.map((row) => ({
      id: row.id,
      number: row.number,
      label: row.label,
      role: row.role,
      title: row.title,
      body: row.body,
      version: row.version,
      updatedAt: row.updated_at,
    })),
    statusEvents: rows.statusEvents.map((row) => ({
      id: row.id,
      at: row.at,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      actorName: row.actor_name,
      agent: row.agent,
    })),
    runs: rows.runs.map((row) => ({
      id: row.id === null ? null : String(row.id),
      source: row.source,
      agent: row.agent,
      job: row.job,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      running: row.running,
    })),
    measures: null,
    measureCoverage: null,
    capabilities: rows.capabilities,
  }
}

export type HostedTaskDetailRows = Omit<LocalTaskDetailRows, 'task' | 'runs' | 'capabilities'> & {
  task: LocalTaskDetailRows['task'] & { id: string; space_name: string }
  runs: Array<{
    id?: string | null
    source: string
    agent: string | null
    job: string | null
    start_at: string
    end_at: string
    open: number | boolean
  }>
  measures: Measures
  measureCoverage: NonNullable<TaskDetail['measureCoverage']>
}

const HOSTED_WRITE_REFUSAL = 'The hosted record does not accept task writes from the dashboard.'

export function hostedTaskDetailFromRows(
  rows: HostedTaskDetailRows,
  readerUserId = '',
): TaskDetail {
  const refused = { allowed: false as const, reason: HOSTED_WRITE_REFUSAL }
  return {
    ...localTaskDetail(
      {
        ...rows,
        task: { ...rows.task, record_id: rows.task.id },
        runs: rows.runs.map((row) => ({
          id: row.id ?? null,
          source: row.source,
          agent: row.agent,
          job: row.job,
          started_at: row.start_at,
          ended_at: row.end_at,
          running: Boolean(row.open),
        })),
        capabilities: {
          setTitle: refused,
          setStatus: refused,
          setBody: refused,
          comment: refused,
          documents: refused,
          statusVocabulary: null,
        },
      },
      readerUserId,
    ),
    task: {
      key: rows.task.key,
      recordId: rows.task.id,
      project: rows.task.project,
      title: rows.task.title,
      status: rows.task.status,
      statusCategory: rows.task.status_category,
      parentKey: rows.task.parent_key,
      body: rows.task.body,
      assignee: rows.task.assignee,
      source: rows.task.source,
      sourceProtocol: rows.task.source_protocol,
      updatedAt: rows.task.updated_at,
      spaceName: rows.task.space_name,
    },
    measures: rows.measures,
    measureCoverage: rows.measureCoverage,
  }
}
