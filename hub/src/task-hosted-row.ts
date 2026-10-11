import { HOSTED_TASK_UPDATE_COLUMNS, type HostedTask } from './hosted-tasks.ts'
import type { TaskRow } from './task.ts'

export type PushableTaskRow = Omit<TaskRow, 'record_id'> & { record_id: string | null }

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/

function hostedInstant(value: string | null): string | null {
  return value !== null && PLAIN_DATE.test(value) ? `${value}T00:00:00.000Z` : value
}

/** The single machine-task to hosted-task wire mapping. */
export function hostedTaskFromTaskRow(row: PushableTaskRow, id: string): HostedTask {
  return {
    id,
    key: row.key,
    project: row.project,
    project_name: row.project,
    title: row.title,
    status: row.status,
    status_category: row.status_category,
    parent_key: row.parent_key,
    parent_id: row.parent_record_id,
    body: row.body,
    assignee: row.assignee,
    opened_at: hostedInstant(row.opened_at),
    closed_at: hostedInstant(row.closed_at),
    source: row.source,
    first_seen: hostedInstant(row.first_seen)!,
    last_seen: hostedInstant(row.last_seen)!,
    created_at: hostedInstant(row.first_seen)!,
    updated_at: hostedInstant(row.updated_at ?? row.last_seen)!,
    deleted_at: null,
    next_document_number: row.next_document_number,
  }
}

export function gitTaskShouldQueue(before: TaskRow | null, after: TaskRow): boolean {
  if (after.source !== 'git') return false
  if (before === null) return true
  const beforeHosted = hostedTaskFromTaskRow(before, before.record_id)
  const afterHosted = hostedTaskFromTaskRow(after, after.record_id)
  return HOSTED_TASK_UPDATE_COLUMNS.some((column) => beforeHosted[column] !== afterHosted[column])
}
