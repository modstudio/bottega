import { SQL } from 'bun'
import { bindTenant } from '../../shared/record/tenant.ts'
import {
  type HostedAcknowledgement,
  type HostedNote,
  hostedNotePullSerializers,
} from './hosted-notes.ts'
import { type HostedSend, serializeHostedSend } from './hosted-reports.ts'
import {
  type HostedComment,
  type HostedDocument,
  type HostedStatusEvent,
  type HostedTask,
  hostedTaskPullSerializers,
  type TaskIdentity,
} from './hosted-tasks.ts'

export const MAX_HUB_CHANGE_PAGE_SIZE = 500

type ChangeRow =
  | HostedTask
  | HostedComment
  | HostedDocument
  | HostedStatusEvent
  | HostedSend
  | HostedNote
  | HostedAcknowledgement
type Reader = (tx: SQL, spaceId: string, ids: readonly string[]) => Promise<Map<string, ChangeRow>>

const rows = <T>(value: unknown) => value as T[]
const byId = <T extends { id: string }>(values: T[]) =>
  new Map(values.map((value) => [value.id, value] as const))
const idList = (ids: readonly string[]) => ids.join(',')

async function taskRows<T extends { id: string }>(
  tx: SQL,
  spaceId: string,
  ids: readonly string[],
  table: string,
  serialize: (row: T) => T,
) {
  if (!ids.length) return new Map<string, T>()
  return byId(
    rows<T>(
      await tx`SELECT * FROM ${tx.unsafe(table)} WHERE space_id=${spaceId}::uuid
        AND id=ANY(string_to_array(${idList(ids)},',')::uuid[])`,
    ).map(serialize),
  )
}
const readTask: Reader = (tx, spaceId, ids) =>
  taskRows(tx, spaceId, ids, 'hub_task', hostedTaskPullSerializers.hub_task)
const readComment: Reader = (tx, spaceId, ids) =>
  taskRows(tx, spaceId, ids, 'hub_task_comment', hostedTaskPullSerializers.hub_task_comment)
const readDocument: Reader = (tx, spaceId, ids) =>
  taskRows(tx, spaceId, ids, 'hub_task_document', hostedTaskPullSerializers.hub_task_document)
const readStatusEvent: Reader = (tx, spaceId, ids) =>
  taskRows(
    tx,
    spaceId,
    ids,
    'hub_task_status_event',
    hostedTaskPullSerializers.hub_task_status_event,
  )
const readNote: Reader = async (tx, spaceId, ids) => {
  if (!ids.length) return new Map()
  return byId(
    rows<HostedNote>(
      await tx`SELECT hub_note.*,number::int number FROM hub_note
        WHERE space_id=${spaceId}::uuid
        AND id=ANY(string_to_array(${idList(ids)},',')::uuid[])`,
    ).map(hostedNotePullSerializers.hub_note),
  )
}
const readAcknowledgement: Reader = (tx, spaceId, ids) =>
  taskRows(
    tx,
    spaceId,
    ids,
    'hub_note_acknowledgement',
    hostedNotePullSerializers.hub_note_acknowledgement,
  )
const readSend: Reader = async (tx, spaceId, ids) => {
  if (!ids.length) return new Map()
  const selected = rows<HostedSend & { recipient_details_json: string }>(
    await tx`SELECT id,at,"window",recipients,projects,items,status,error,test,
      created_at,machine,subscription_id,period_start,period_end,
      COALESCE((SELECT json_agg(json_build_object('user_id',r.user_id,'name',r.name,'email',r.email)
        ORDER BY r.created_at,r.id) FROM hub_send_recipient r WHERE r.send_id=hub_send.id),'[]')::text
        AS recipient_details_json
      FROM hub_send WHERE space_id=${spaceId}::uuid
      AND id=ANY(string_to_array(${idList(ids)},',')::uuid[])`,
  )
  return byId(selected.map(serializeHostedSend))
}

export const READABLE_HUB_CHANGES = {
  hub_task: { serializer: hostedTaskPullSerializers.hub_task, reader: readTask },
  hub_task_comment: { serializer: hostedTaskPullSerializers.hub_task_comment, reader: readComment },
  hub_task_document: {
    serializer: hostedTaskPullSerializers.hub_task_document,
    reader: readDocument,
  },
  hub_task_status_event: {
    serializer: hostedTaskPullSerializers.hub_task_status_event,
    reader: readStatusEvent,
  },
  hub_send: { serializer: serializeHostedSend, reader: readSend },
  hub_note: { serializer: hostedNotePullSerializers.hub_note, reader: readNote },
  hub_note_acknowledgement: {
    serializer: hostedNotePullSerializers.hub_note_acknowledgement,
    reader: readAcknowledgement,
  },
} as const

const HUB_CHANGES_NOT_YET_READABLE = ['hub_interval', 'hub_day'] as const
export type ReadableHubChangeTable = keyof typeof READABLE_HUB_CHANGES

export function hubChangeReadability(table: string): 'readable' | 'not-yet-readable' | null {
  if (table in READABLE_HUB_CHANGES) return 'readable'
  if ((HUB_CHANGES_NOT_YET_READABLE as readonly string[]).includes(table)) return 'not-yet-readable'
  return null
}

type Entry = {
  sequence: string | number
  table_name: string
  row_id: string
  op: 'upsert' | 'delete'
}
const sequenceNumber = (value: string | number) => {
  const sequence = Number(value)
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new Error('hosted change sequence must be a non-negative safe integer')
  return sequence
}

export async function readHostedChangesInTransaction(
  tx: SQL,
  identity: TaskIdentity,
  input: { after: number; limit: number; tables: readonly ReadableHubChangeTable[] },
) {
  const metadata = rows<{ head: string | number; oldest: string | number | null }>(
    await tx`SELECT COALESCE((SELECT sequence FROM hub_change_head
        WHERE space_id=${identity.spaceId}::uuid),0)::text head,
      (SELECT MIN(sequence)::text FROM hub_change WHERE space_id=${identity.spaceId}::uuid) oldest`,
  )[0]!
  const head = sequenceNumber(metadata.head)
  const oldest = metadata.oldest === null ? null : sequenceNumber(metadata.oldest)
  const resetRequired = input.after > head || (oldest !== null && input.after < oldest - 1)
  if (resetRequired)
    return { head, oldest, next: input.after, more: false, resetRequired: true, changes: [] }

  const candidates = rows<Entry>(
    await tx`SELECT sequence::text,table_name,row_id::text,op FROM hub_change
      WHERE space_id=${identity.spaceId}::uuid AND sequence>${input.after}
      ORDER BY sequence LIMIT ${input.limit + 1}`,
  )
  const entries = candidates.slice(0, input.limit)
  const next = entries.length ? sequenceNumber(entries.at(-1)!.sequence) : input.after
  const wanted = new Set(input.tables)
  const collapsed = new Map<string, Entry>()
  for (const entry of entries) {
    if (
      hubChangeReadability(entry.table_name) !== 'readable' ||
      !wanted.has(entry.table_name as ReadableHubChangeTable)
    )
      continue
    collapsed.set(`${entry.table_name}:${entry.row_id}`, entry)
  }
  const finalEntries = [...collapsed.values()].sort(
    (a, b) => sequenceNumber(a.sequence) - sequenceNumber(b.sequence),
  )
  const upsertIds = finalEntries
    .filter((entry) => entry.op === 'upsert')
    .map((entry) => entry.row_id)
  const superseded = new Set<string>()
  if (upsertIds.length) {
    const later = rows<Pick<Entry, 'table_name' | 'row_id'>>(
      await tx`SELECT table_name,row_id::text FROM hub_change
        WHERE space_id=${identity.spaceId}::uuid AND sequence>${next}
        AND table_name=ANY(string_to_array(${[...wanted].join(',')},',')::text[])
        AND row_id=ANY(string_to_array(${idList(upsertIds)},',')::uuid[])`,
    )
    for (const entry of later) superseded.add(`${entry.table_name}:${entry.row_id}`)
  }
  const currentRows = new Map<string, ChangeRow>()
  for (const table of input.tables) {
    const ids = finalEntries
      .filter(
        (entry) =>
          entry.table_name === table &&
          entry.op === 'upsert' &&
          !superseded.has(`${entry.table_name}:${entry.row_id}`),
      )
      .map((entry) => entry.row_id)
    const found = await READABLE_HUB_CHANGES[table].reader(tx, identity.spaceId, ids)
    for (const [id, row] of found) currentRows.set(`${table}:${id}`, row)
  }
  const changes = finalEntries.flatMap((entry) => {
    const base = {
      sequence: sequenceNumber(entry.sequence),
      table: entry.table_name as ReadableHubChangeTable,
      id: entry.row_id,
      op: entry.op,
    }
    if (entry.op === 'delete') return [base]
    if (superseded.has(`${entry.table_name}:${entry.row_id}`)) return []
    const row = currentRows.get(`${entry.table_name}:${entry.row_id}`)
    return row ? [{ ...base, row }] : []
  })
  return {
    head,
    oldest,
    next,
    more: candidates.length > input.limit,
    resetRequired: false,
    changes,
  }
}

export async function listHostedChanges(
  url: string,
  identity: TaskIdentity,
  input: Parameters<typeof readHostedChangesInTransaction>[2],
) {
  const client = new SQL(url)
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
      await bindTenant(tx, identity)
      return readHostedChangesInTransaction(tx, identity, input)
    })
  } finally {
    await client.close()
  }
}
