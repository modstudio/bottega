// concern: hosted-record-changes
/** Materializes the hub portion of the shared record change feed through the existing serializers. */
import type { SQL } from 'bun'
import {
  type RecordChangeCursor,
  type RecordChangeEntry,
  type RecordChangeReadPage,
  readRecordChanges,
} from '../../shared/record/record-changes.ts'
import {
  type HostedAcknowledgement,
  type HostedNote,
  hostedNotePullSerializers,
} from './hosted-notes.ts'
import type { HostedChangeRow, HostedRecordChange } from './hosted-record-change-wire.ts'
import { type HostedSend, serializeHostedSend } from './hosted-reports.ts'
import {
  type HostedComment,
  type HostedDocument,
  type HostedStatusEvent,
  type HostedTask,
  hostedTaskPullSerializers,
} from './hosted-tasks.ts'
import type { TaskIdentity } from './hosted-tenant.ts'

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
      await tx`SELECT * FROM ${tx.unsafe(table)} WHERE space_id=${spaceId}::uuid AND id=ANY(string_to_array(${idList(ids)},',')::uuid[])`,
    ).map(serialize),
  )
}
const taskReader =
  <T extends { id: string }>(table: string, serialize: (row: T) => T) =>
  async (tx: SQL, spaceId: string, ids: readonly string[]) =>
    taskRows(tx, spaceId, ids, table, serialize)

const READABLE_HUB_CHANGES = {
  hub_task: taskReader<HostedTask>('hub_task', hostedTaskPullSerializers.hub_task),
  hub_task_comment: taskReader<HostedComment>(
    'hub_task_comment',
    hostedTaskPullSerializers.hub_task_comment,
  ),
  hub_task_document: taskReader<HostedDocument>(
    'hub_task_document',
    hostedTaskPullSerializers.hub_task_document,
  ),
  hub_task_status_event: taskReader<HostedStatusEvent>(
    'hub_task_status_event',
    hostedTaskPullSerializers.hub_task_status_event,
  ),
  hub_send: async (tx: SQL, spaceId: string, ids: readonly string[]) => {
    if (!ids.length) return new Map<string, HostedSend>()
    const selected = rows<HostedSend & { recipient_details_json: string }>(
      await tx`SELECT id,at,"window",recipients,projects,items,status,error,test,created_at,machine,subscription_id,period_start,period_end,COALESCE((SELECT json_agg(json_build_object('user_id',r.user_id,'name',r.name,'email',r.email) ORDER BY r.created_at,r.id) FROM hub_send_recipient r WHERE r.send_id=hub_send.id),'[]')::text AS recipient_details_json FROM hub_send WHERE space_id=${spaceId}::uuid AND id=ANY(string_to_array(${idList(ids)},',')::uuid[])`,
    )
    return byId(selected.map(serializeHostedSend))
  },
  hub_note: async (tx: SQL, spaceId: string, ids: readonly string[]) => {
    if (!ids.length) return new Map<string, HostedNote>()
    return byId(
      rows<HostedNote>(
        await tx`SELECT hub_note.*,number::int number FROM hub_note WHERE space_id=${spaceId}::uuid AND id=ANY(string_to_array(${idList(ids)},',')::uuid[])`,
      ).map(hostedNotePullSerializers.hub_note),
    )
  },
  hub_note_acknowledgement: taskReader<HostedAcknowledgement>(
    'hub_note_acknowledgement',
    hostedNotePullSerializers.hub_note_acknowledgement,
  ),
} as const

type ReadableHubChangeTable = keyof typeof READABLE_HUB_CHANGES

export const HOSTED_RECORD_CHANGE_TABLES = Object.keys(
  READABLE_HUB_CHANGES,
) as ReadableHubChangeTable[]

type FeedPage = Exclude<RecordChangeReadPage, { resetRequired: true }>

function collapsedEntries(changes: readonly RecordChangeEntry[]) {
  const collapsed = new Map<string, RecordChangeEntry>()
  for (const change of changes)
    collapsed.set(`${change.table}:${change.space}:${change.id}`, change)
  const keys = new Set(collapsed.values())
  return changes.filter((change) => keys.has(change))
}

async function materializeHostedRecordChangePage(tx: SQL, page: FeedPage) {
  const entries = collapsedEntries(page.changes).filter((entry) =>
    HOSTED_RECORD_CHANGE_TABLES.includes(entry.table as ReadableHubChangeTable),
  )
  const current = new Map<string, HostedChangeRow>()
  for (const table of HOSTED_RECORD_CHANGE_TABLES) {
    const spaces = new Set(
      entries.filter((entry) => entry.table === table).map((entry) => entry.space),
    )
    for (const space of spaces) {
      const ids = entries
        .filter((entry) => entry.table === table && entry.space === space && entry.op === 'upsert')
        .map((entry) => entry.id)
      const found = await READABLE_HUB_CHANGES[table](tx, space, ids)
      for (const [id, row] of found) current.set(`${table}:${space}:${id}`, row)
    }
  }
  const changes = entries.flatMap((entry): HostedRecordChange[] => {
    const base = {
      table: entry.table as ReadableHubChangeTable,
      id: entry.id,
      space: entry.space,
      op: entry.op,
    }
    if (entry.op === 'delete') return [base]
    const row = current.get(`${entry.table}:${entry.space}:${entry.id}`)
    if (row !== undefined) return [{ ...base, row }]
    // hub_note_hidden_select makes an unreadable note upsert a delete for this reader.
    return entry.table === 'hub_note' ? [{ ...base, op: 'delete' }] : []
  })
  return { ...page, changes }
}

export async function readHostedRecordChanges(
  client: SQL,
  identity: TaskIdentity,
  input: { after: RecordChangeCursor | null; limit: number },
) {
  return readRecordChanges(
    client,
    identity,
    input.after,
    input.limit,
    HOSTED_RECORD_CHANGE_TABLES,
    async (tx, page) => (page.resetRequired ? page : materializeHostedRecordChangePage(tx, page)),
  )
}

export type HostedRecordChangeReadResult = Awaited<ReturnType<typeof readHostedRecordChanges>>
