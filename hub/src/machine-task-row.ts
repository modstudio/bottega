import type { PushedTask } from './push-contract.ts'

export type MachineTaskRow = {
  record_id: string
  key: string
  project: string
  title: string | null
  status: string | null
  status_category: string | null
  parent_key: string | null
  parent_record_id: string | null
  body: string | null
  assignee: string | null
  opened_at: string | null
  closed_at: string | null
  source: 'mcp' | 'git' | 'local'
  first_seen: string
  last_seen: string
  updated_at: string
  next_document_number: number
}

const MEANINGFUL_TASK_COLUMNS = [
  'record_id',
  'key',
  'project',
  'title',
  'status',
  'status_category',
  'parent_key',
  'parent_record_id',
  'body',
  'assignee',
  'opened_at',
  'closed_at',
  'source',
  'updated_at',
  'next_document_number',
] as const

/** Match the fields for which the hosted task mirror performs an update. */
export function machineTaskMeaningfullyDiffers(
  before: MachineTaskRow | null,
  after: MachineTaskRow,
): boolean {
  return (
    before === null || MEANINGFUL_TASK_COLUMNS.some((column) => before[column] !== after[column])
  )
}

export function pushedTaskFromMachineRow(row: MachineTaskRow): PushedTask {
  return {
    id: row.record_id,
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
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    source: row.source,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    created_at: row.first_seen,
    updated_at: row.updated_at,
    deleted_at: null,
    next_document_number: row.next_document_number,
  }
}
