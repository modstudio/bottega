export const PUSHABLE_HUB_CHANGE_TABLES = ['hub_task_status_event'] as const

export type PushableHubChangeTable = (typeof PUSHABLE_HUB_CHANGE_TABLES)[number]

export type PushedStatusEvent = {
  id: string
  task_key: string
  task_id: string | null
  project_name: string
  at: string
  from_status: string | null
  to_status: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export type HostedPushChange =
  | { table: PushableHubChangeTable; id: string; op: 'delete' }
  | { table: PushableHubChangeTable; id: string; op: 'upsert'; row: PushedStatusEvent }

export type HostedPushOutcome =
  | { id: string; status: 'applied' | 'duplicate' }
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

function rejected(id: string, reason: string): ParsedHostedPushItem {
  return { outcome: { id, status: 'rejected', reason } }
}

export function parseHostedPushItem(value: unknown): ParsedHostedPushItem {
  const input = object(value)
  const id = typeof input?.id === 'string' ? input.id : String(input?.id ?? '')
  if (!input) return rejected(id, 'pushed change must be an object')
  if (typeof input.id !== 'string' || input.id.length === 0)
    return rejected(id, 'pushed change id must be a non-empty string')
  if (!PUSHABLE_HUB_CHANGE_TABLES.includes(input.table as PushableHubChangeTable))
    return rejected(
      id,
      `table ${String(input.table)} is not accepted; accepted tables: ${PUSHABLE_HUB_CHANGE_TABLES.join(', ')}`,
    )
  if (input.op !== 'upsert' && input.op !== 'delete')
    return rejected(id, 'operation must be upsert or delete')
  const table = input.table as PushableHubChangeTable
  if (input.op === 'delete') return { input: { table, id: input.id, op: 'delete' } }
  const row = object(input.row)
  if (!row) return rejected(id, `${table} upsert requires a row`)
  if (row.id !== input.id)
    return rejected(id, `${table} upsert requires a row whose id matches the pointer`)
  const stringFields = [
    'task_key',
    'project_name',
    'at',
    'to_status',
    'created_at',
    'updated_at',
  ] as const
  for (const field of stringFields)
    if (typeof row[field] !== 'string')
      return rejected(id, `${table} row.${field} must be a string`)
  for (const field of ['task_id', 'from_status', 'deleted_at'] as const)
    if (!nullableString(row[field]))
      return rejected(id, `${table} row.${field} must be a string or null`)
  return {
    input: {
      table,
      id: input.id,
      op: 'upsert',
      row: row as PushedStatusEvent,
    },
  }
}
