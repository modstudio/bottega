export const HOSTED_TASK_TABLE = 'hub_task'
export const HOSTED_STATUS_EVENT_TABLE = 'hub_task_status_event'
export const HOSTED_COMMENT_TABLE = 'hub_task_comment'
export const HOSTED_DOCUMENT_TABLE = 'hub_task_document'
export const HOSTED_INTERVAL_TABLE = 'hub_interval'
export const HOSTED_DAY_TABLE = 'hub_day'
export const PUSHABLE_HUB_CHANGE_TABLES = [
  HOSTED_TASK_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_COMMENT_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_INTERVAL_TABLE,
  HOSTED_DAY_TABLE,
] as const

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

export type PushedInterval = {
  id: string
  task_key: string | null
  project_name: string | null
  source: string
  agent: string | null
  job: string | null
  start_at: string
  end_at: string
  claude_tokens: number
  vendor_tokens: number
  vendor_cost_usd: number | null
  ref: string
  via: string | null
  open: number
  session_id: string | null
  user_id: string | null
}

export type PushedDay = {
  id: string
  day: string
  claude_tokens: number
  cache_read: number
  messages: number
  tasks: number
  canon_tokens: number
  other_tokens: number
  commits: number
  files: number
  lines_product: number
  lines_test: number
  lines_docs: number
  lines_config: number
  lines_generated: number
  collected_at: string
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

type PushedComment = {
  id: string
  task_key: string
  task_id?: string | null
  project_name: string
  body: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}
type PushedDocument = {
  id: string
  number: number | null
  task_key: string
  task_id?: string | null
  project_name: string
  role: string | null
  title: string
  body: string
  version: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

const HOSTED_COMMENT_UPDATE_COLUMNS = [
  'task_key',
  'task_id',
  'body',
  'updated_at',
  'deleted_at',
] as const
const HOSTED_DOCUMENT_UPDATE_COLUMNS = ['role', 'title', 'body', 'version'] as const

export const HOSTED_TASK_UPDATE_COLUMNS = [
  'title',
  'status',
  'status_category',
  'parent_key',
  'body',
  'assignee',
] as const satisfies readonly (keyof PushedTask)[]

export type HostedPushChange =
  | { table: PushableHubChangeTable; id: string; op: 'delete' }
  | {
      table: typeof HOSTED_TASK_TABLE
      id: string
      op: 'upsert'
      row: PushedTask
      fields?: string[] | null
    }
  | {
      table: typeof HOSTED_COMMENT_TABLE
      id: string
      op: 'upsert'
      row: PushedComment
      fields?: string[] | null
    }
  | {
      table: typeof HOSTED_DOCUMENT_TABLE
      id: string
      op: 'upsert'
      row: PushedDocument
      fields?: string[] | null
    }
  | {
      table: typeof HOSTED_STATUS_EVENT_TABLE
      id: string
      op: 'upsert'
      row: PushedStatusEvent
    }
  | { table: typeof HOSTED_INTERVAL_TABLE; id: string; op: 'upsert'; row: PushedInterval }
  | { table: typeof HOSTED_INTERVAL_TABLE; id: string; op: 'delete' }
  | { table: typeof HOSTED_DAY_TABLE; id: string; op: 'upsert'; row: PushedDay }

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

function evidenceFieldError(
  row: Record<string, unknown>,
  table: typeof HOSTED_INTERVAL_TABLE | typeof HOSTED_DAY_TABLE,
  strings: readonly string[],
  nullable: readonly string[],
  numbers: readonly string[],
): string | null {
  for (const field of strings)
    if (typeof row[field] !== 'string') return `${table} row.${field} must be a string`
  for (const field of nullable)
    if (!nullableString(row[field])) return `${table} row.${field} must be a string or null`
  for (const field of numbers)
    if (typeof row[field] !== 'number' || !Number.isFinite(row[field]))
      return `${table} row.${field} must be a finite number`
  return null
}

function parseIntervalRow(value: unknown, id: string): PushedInterval | string {
  const row = object(value)
  if (!row) return `${HOSTED_INTERVAL_TABLE} upsert requires a row`
  if (row.id !== id)
    return `${HOSTED_INTERVAL_TABLE} upsert requires a row whose id matches the pointer`
  const error = evidenceFieldError(
    row,
    HOSTED_INTERVAL_TABLE,
    ['source', 'start_at', 'end_at', 'ref'],
    ['task_key', 'project_name', 'agent', 'job', 'via', 'session_id', 'user_id'],
    ['claude_tokens', 'vendor_tokens', 'open'],
  )
  if (error) return error
  if (
    row.vendor_cost_usd !== null &&
    (typeof row.vendor_cost_usd !== 'number' || !Number.isFinite(row.vendor_cost_usd))
  )
    return `${HOSTED_INTERVAL_TABLE} row.vendor_cost_usd must be a finite number or null`
  for (const field of ['start_at', 'end_at'] as const)
    if (!isTimestamp(row[field]))
      return `${HOSTED_INTERVAL_TABLE} row.${field} must be an ISO timestamp`
  if (typeof row.user_id === 'string' && !UUID.test(row.user_id))
    return `${HOSTED_INTERVAL_TABLE} row.user_id must be a UUID, null, or absent`
  return row as PushedInterval
}

function parseDayRow(value: unknown, id: string): PushedDay | string {
  const row = object(value)
  if (!row) return `${HOSTED_DAY_TABLE} upsert requires a row`
  if (row.id !== id) return `${HOSTED_DAY_TABLE} upsert requires a row whose id matches the pointer`
  const error = evidenceFieldError(
    row,
    HOSTED_DAY_TABLE,
    ['day', 'collected_at'],
    [],
    [
      'claude_tokens',
      'cache_read',
      'messages',
      'tasks',
      'canon_tokens',
      'other_tokens',
      'commits',
      'files',
      'lines_product',
      'lines_test',
      'lines_docs',
      'lines_config',
      'lines_generated',
    ],
  )
  if (error) return error
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day as string))
    return `${HOSTED_DAY_TABLE} row.day must be a date`
  if (!isTimestamp(row.collected_at))
    return `${HOSTED_DAY_TABLE} row.collected_at must be an ISO timestamp`
  return row as PushedDay
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

function parseTaskUpsert(input: Record<string, unknown> & { id: string }): ParsedHostedPushItem {
  const id = input.id
  const row = parseTaskRow(input.row, id)
  if (typeof row === 'string') return rejected(id, row)
  const fields = parseFields(input.fields, HOSTED_TASK_UPDATE_COLUMNS, HOSTED_TASK_TABLE)
  if (typeof fields === 'string') return rejected(id, fields)
  return {
    input: {
      table: HOSTED_TASK_TABLE,
      id,
      op: 'upsert',
      row,
      ...(fields === null ? {} : { fields }),
    },
  }
}

function parseTaskChildUpsert(
  input: Record<string, unknown> & { id: string },
  table: typeof HOSTED_COMMENT_TABLE | typeof HOSTED_DOCUMENT_TABLE,
): ParsedHostedPushItem {
  const { id } = input
  const row = object(input.row)
  if (!row || row.id !== id)
    return rejected(id, `${table} upsert requires a row whose id matches the pointer`)
  const required =
    table === HOSTED_COMMENT_TABLE
      ? ['task_key', 'project_name', 'body', 'created_at', 'updated_at']
      : ['task_key', 'project_name', 'title', 'body', 'version', 'created_at', 'updated_at']
  for (const field of required)
    if (typeof row[field] !== 'string')
      return rejected(id, `${table} row.${field} must be a string`)
  const allowed =
    table === HOSTED_COMMENT_TABLE ? HOSTED_COMMENT_UPDATE_COLUMNS : HOSTED_DOCUMENT_UPDATE_COLUMNS
  const fields = parseFields(input.fields, allowed, table)
  if (typeof fields === 'string') return rejected(id, fields)
  return {
    input: {
      table,
      id,
      op: 'upsert',
      row: row as never,
      ...(fields === null ? {} : { fields }),
    } as HostedPushChange,
  }
}

function parseEvidenceUpsert(
  input: Record<string, unknown> & { id: string },
  table: typeof HOSTED_INTERVAL_TABLE | typeof HOSTED_DAY_TABLE,
): ParsedHostedPushItem {
  const id = input.id
  if (table === HOSTED_INTERVAL_TABLE) {
    const row = parseIntervalRow(input.row, id)
    if (typeof row === 'string') return rejected(id, row)
    return { input: { table, id, op: 'upsert', row } }
  }
  if (table === HOSTED_DAY_TABLE) {
    const row = parseDayRow(input.row, id)
    if (typeof row === 'string') return rejected(id, row)
    return { input: { table, id, op: 'upsert', row } }
  }
  return rejected(id, `${table} is not evidence`)
}

function parseHostedUpsert(
  input: Record<string, unknown> & { id: string },
  table: PushableHubChangeTable,
): ParsedHostedPushItem {
  if (table === HOSTED_TASK_TABLE) return parseTaskUpsert(input)
  if (table === HOSTED_COMMENT_TABLE || table === HOSTED_DOCUMENT_TABLE)
    return parseTaskChildUpsert(input, table)
  if (table === HOSTED_INTERVAL_TABLE || table === HOSTED_DAY_TABLE)
    return parseEvidenceUpsert(input, table)
  const row = parseStatusEventRow(input.row, input.id, table)
  if (typeof row === 'string') return rejected(input.id, row)
  return { input: { table, id: input.id, op: 'upsert', row } }
}

function parseFields(
  value: unknown,
  allowed: readonly string[],
  table: string,
): string[] | null | string {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some((field) => typeof field !== 'string'))
    return `${table} fields must be a JSON array of column names or null`
  const unknown = value.find((field) => !allowed.includes(field as string))
  if (unknown) return `${table} fields contains unknown column ${String(unknown)}`
  return [...new Set(value as string[])]
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
  if (input.op === 'upsert')
    return parseHostedUpsert(input as Record<string, unknown> & { id: string }, table)
  if (table === HOSTED_DAY_TABLE) return rejected(id, `${HOSTED_DAY_TABLE} does not accept delete`)
  return { input: { table, id: input.id, op: 'delete' } as HostedPushChange }
}
