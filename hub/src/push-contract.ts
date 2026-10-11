export const HOSTED_TASK_TABLE = 'hub_task'
export const HOSTED_STATUS_EVENT_TABLE = 'hub_task_status_event'
const PUSHABLE_HUB_CHANGE_TABLES = [HOSTED_TASK_TABLE, HOSTED_STATUS_EVENT_TABLE] as const

export type PushableHubChangeTable = (typeof PUSHABLE_HUB_CHANGE_TABLES)[number]

export type PushedStatusEvent = {
  id: string
  task_key: string
  task_id?: string | null
  project_name: string
  at: string
  from_status: string | null
  to_status: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

const TASK_STATUS_CATEGORIES = ['open', 'active', 'review', 'done', 'dropped'] as const
type TaskStatusCategory = (typeof TASK_STATUS_CATEGORIES)[number]

export type PushedTask = {
  id: string
  key: string
  project: string
  project_name: string
  title: string | null
  status: string | null
  status_category: TaskStatusCategory | null
  parent_key: string | null
  parent_id?: string | null
  body: string | null
  assignee: string | null
  opened_at: string | null
  closed_at: string | null
  source: 'mcp' | 'git' | 'local'
  first_seen: string
  last_seen: string
  created_at: string
  updated_at: string
  deleted_at: string | null
  next_document_number: number
}

export const HOSTED_TASK_UPDATE_COLUMNS = [
  'project_name',
  'key',
  'project',
  'title',
  'status',
  'status_category',
  'parent_key',
  'parent_id',
  'body',
  'assignee',
  'opened_at',
  'closed_at',
  'source',
  'updated_at',
  'deleted_at',
  'next_document_number',
] as const satisfies readonly (keyof PushedTask)[]

export type HostedPushChange =
  | { table: PushableHubChangeTable; id: string; op: 'delete' }
  | { table: typeof HOSTED_TASK_TABLE; id: string; op: 'upsert'; row: PushedTask }
  | {
      table: typeof HOSTED_STATUS_EVENT_TABLE
      id: string
      op: 'upsert'
      row: PushedStatusEvent
    }

export type HostedPushOutcome =
  | { id: string; status: 'applied' | 'duplicate'; adoptedId?: string }
  | { id: string; status: 'rejected'; reason: string }

type ParsedHostedPushItem =
  | { input: HostedPushChange }
  | { outcome: Extract<HostedPushOutcome, { status: 'rejected' }> }

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))

function rejected(id: string, reason: string): ParsedHostedPushItem {
  return { outcome: { id, status: 'rejected', reason } }
}

function parseStatusEventRow(
  value: unknown,
  id: string,
  table: PushableHubChangeTable,
): PushedStatusEvent | string {
  const row = object(value)
  if (!row) return `${table} upsert requires a row`
  if (row.id !== id) return `${table} upsert requires a row whose id matches the pointer`
  const stringFields = ['task_key', 'project_name', 'to_status'] as const
  for (const field of stringFields)
    if (typeof row[field] !== 'string') return `${table} row.${field} must be a string`
  if (row.task_id !== undefined && !nullableString(row.task_id))
    return `${table} row.task_id must be a string, null, or absent`
  if (typeof row.task_id === 'string' && !UUID.test(row.task_id))
    return `${table} row.task_id must be a UUID, null, or absent`
  if (!nullableString(row.from_status)) return `${table} row.from_status must be a string or null`
  for (const field of ['at', 'created_at', 'updated_at'] as const)
    if (!isTimestamp(row[field])) return `${table} row.${field} must be an ISO timestamp`
  if (row.deleted_at !== null && !isTimestamp(row.deleted_at))
    return `${table} row.deleted_at must be an ISO timestamp or null`
  return row as PushedStatusEvent
}

function parseTaskRow(value: unknown, id: string): PushedTask | string {
  const row = object(value)
  if (!row) return `${HOSTED_TASK_TABLE} upsert requires a row`
  if (row.id !== id)
    return `${HOSTED_TASK_TABLE} upsert requires a row whose id matches the pointer`
  const fieldError = taskFieldError(row)
  if (fieldError) return fieldError
  const referenceError = taskReferenceError(row)
  if (referenceError) return referenceError
  const timestampError = taskTimestampError(row)
  if (timestampError) return timestampError
  if (!['mcp', 'git', 'local'].includes(String(row.source)))
    return `${HOSTED_TASK_TABLE} row.source must be mcp, git, or local`
  if (!Number.isSafeInteger(row.next_document_number) || Number(row.next_document_number) < 1)
    return `${HOSTED_TASK_TABLE} row.next_document_number must be a positive safe integer`
  return row as PushedTask
}

function taskFieldError(row: Record<string, unknown>): string | null {
  for (const field of ['key', 'project', 'project_name'] as const)
    if (typeof row[field] !== 'string') return `${HOSTED_TASK_TABLE} row.${field} must be a string`
  for (const field of ['title', 'status', 'parent_key', 'body', 'assignee'] as const)
    if (!nullableString(row[field]))
      return `${HOSTED_TASK_TABLE} row.${field} must be a string or null`
  if (
    row.status_category !== null &&
    !TASK_STATUS_CATEGORIES.includes(row.status_category as TaskStatusCategory)
  )
    return `${HOSTED_TASK_TABLE} row.status_category must be open, active, review, done, dropped, or null`
  return null
}

function taskReferenceError(row: Record<string, unknown>): string | null {
  if (row.parent_id !== undefined && !nullableString(row.parent_id))
    return `${HOSTED_TASK_TABLE} row.parent_id must be a string, null, or absent`
  if (typeof row.parent_id === 'string' && !UUID.test(row.parent_id))
    return `${HOSTED_TASK_TABLE} row.parent_id must be a UUID, null, or absent`
  return null
}

function taskTimestampError(row: Record<string, unknown>): string | null {
  for (const field of ['opened_at', 'closed_at', 'deleted_at'] as const)
    if (row[field] !== null && !isTimestamp(row[field]))
      return `${HOSTED_TASK_TABLE} row.${field} must be an ISO timestamp or null`
  for (const field of ['first_seen', 'last_seen', 'created_at', 'updated_at'] as const)
    if (!isTimestamp(row[field]))
      return `${HOSTED_TASK_TABLE} row.${field} must be an ISO timestamp`
  return null
}

export function parseHostedPushItem(value: unknown): ParsedHostedPushItem {
  const input = object(value)
  const id = typeof input?.id === 'string' ? input.id : String(input?.id ?? '')
  if (!input) return rejected(id, 'pushed change must be an object')
  if (typeof input.id !== 'string' || input.id.length === 0)
    return rejected(id, 'pushed change id must be a non-empty string')
  if (!UUID.test(input.id)) return rejected(id, 'pushed change id must be a UUID')
  if (!PUSHABLE_HUB_CHANGE_TABLES.includes(input.table as PushableHubChangeTable))
    return rejected(
      id,
      `table ${String(input.table)} is not accepted; accepted tables: ${PUSHABLE_HUB_CHANGE_TABLES.join(', ')}`,
    )
  if (input.op !== 'upsert' && input.op !== 'delete')
    return rejected(id, 'operation must be upsert or delete')
  const table = input.table as PushableHubChangeTable
  if (input.op === 'delete') return { input: { table, id: input.id, op: 'delete' } }
  if (table === HOSTED_TASK_TABLE) {
    const row = parseTaskRow(input.row, input.id)
    if (typeof row === 'string') return rejected(id, row)
    return { input: { table, id: input.id, op: 'upsert', row } }
  }
  const row = parseStatusEventRow(input.row, input.id, table)
  if (typeof row === 'string') return rejected(id, row)
  return { input: { table, id: input.id, op: 'upsert', row } }
}
