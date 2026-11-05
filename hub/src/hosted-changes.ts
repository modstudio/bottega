import type { SQL } from 'bun'
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
} from './hosted-tasks.ts'
import type { TaskIdentity } from './hosted-tenant.ts'

export const MAX_HUB_CHANGE_PAGE_SIZE = 500

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
const taskReader =
  <T extends { id: string }>(table: string, serialize: (row: T) => T) =>
  async (tx: SQL, spaceId: string, ids: readonly string[]) =>
    taskRows(tx, spaceId, ids, table, serialize)

export const READABLE_HUB_CHANGES = {
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
      await tx`SELECT id,at,"window",recipients,projects,items,status,error,test,
        created_at,machine,subscription_id,period_start,period_end,
        COALESCE((SELECT json_agg(json_build_object('user_id',r.user_id,'name',r.name,'email',r.email)
          ORDER BY r.created_at,r.id) FROM hub_send_recipient r WHERE r.send_id=hub_send.id),'[]')::text
          AS recipient_details_json
        FROM hub_send WHERE space_id=${spaceId}::uuid
        AND id=ANY(string_to_array(${idList(ids)},',')::uuid[])`,
    )
    return byId(selected.map(serializeHostedSend))
  },
  hub_note: async (tx: SQL, spaceId: string, ids: readonly string[]) => {
    if (!ids.length) return new Map<string, HostedNote>()
    return byId(
      rows<HostedNote>(
        await tx`SELECT hub_note.*,number::int number FROM hub_note
          WHERE space_id=${spaceId}::uuid
          AND id=ANY(string_to_array(${idList(ids)},',')::uuid[])`,
      ).map(hostedNotePullSerializers.hub_note),
    )
  },
  hub_note_acknowledgement: taskReader<HostedAcknowledgement>(
    'hub_note_acknowledgement',
    hostedNotePullSerializers.hub_note_acknowledgement,
  ),
} as const

const HUB_CHANGES_NOT_YET_READABLE = ['hub_interval', 'hub_day'] as const
export type ReadableHubChangeTable = keyof typeof READABLE_HUB_CHANGES
type ReaderRow<T> = T extends (...args: infer _Args) => Promise<Map<string, infer Row>>
  ? Row
  : never
type ChangeRow = ReaderRow<(typeof READABLE_HUB_CHANGES)[ReadableHubChangeTable]>

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

export async function laterRowKeys(
  tx: SQL,
  spaceId: string,
  after: number,
  tables: readonly string[],
  ids: readonly string[],
) {
  if (!ids.length) return []
  const later = rows<Pick<Entry, 'table_name' | 'row_id'>>(
    await tx`SELECT DISTINCT table_name,row_id::text FROM hub_change
      WHERE hub_change.space_id=${spaceId}::uuid
      AND hub_change.sequence>${after}
      AND table_name=ANY(string_to_array(${tables.join(',')},',')::text[])
      AND row_id=ANY(string_to_array(${idList(ids)},',')::uuid[])`,
  )
  return later.map((entry) => `${entry.table_name}:${entry.row_id}`)
}

export async function readHostedChangesInTransaction(
  tx: SQL,
  identity: TaskIdentity,
  input: { after: number; limit: number; tables: readonly ReadableHubChangeTable[] },
) {
  const metadata = rows<{ head: string | number; oldest: string | number | null }>(
    await tx`SELECT COALESCE((SELECT hub_change_head.sequence FROM hub_change_head
        WHERE hub_change_head.space_id=${identity.spaceId}::uuid),0)::text head,
      (SELECT MIN(hub_change.sequence)::text FROM hub_change
        WHERE hub_change.space_id=${identity.spaceId}::uuid) oldest`,
  )[0]!
  const head = sequenceNumber(metadata.head)
  const oldest = metadata.oldest === null ? null : sequenceNumber(metadata.oldest)
  const resetRequired =
    input.after > head || (input.after < head && (oldest === null || input.after < oldest - 1))
  if (resetRequired)
    return { head, oldest, next: input.after, more: false, resetRequired: true, changes: [] }

  const candidates = rows<Entry>(
    await tx`SELECT hub_change.sequence::text,table_name,row_id::text,op FROM hub_change
      WHERE hub_change.space_id=${identity.spaceId}::uuid
        AND hub_change.sequence>${input.after}
      ORDER BY hub_change.sequence LIMIT ${input.limit + 1}`,
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
  const superseded = new Set(
    await laterRowKeys(
      tx,
      identity.spaceId,
      next,
      [...wanted],
      finalEntries.map((entry) => entry.row_id),
    ),
  )
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
    const found = await READABLE_HUB_CHANGES[table](tx, identity.spaceId, ids)
    for (const [id, row] of found) currentRows.set(`${table}:${id}`, row)
  }
  const changes = finalEntries.flatMap((entry) => {
    const base = {
      sequence: sequenceNumber(entry.sequence),
      table: entry.table_name as ReadableHubChangeTable,
      id: entry.row_id,
      op: entry.op,
    }
    if (superseded.has(`${entry.table_name}:${entry.row_id}`)) return []
    if (entry.op === 'delete') return [base]
    const row = currentRows.get(`${entry.table_name}:${entry.row_id}`)
    if (row) return [{ ...base, row }]
    // hub_note_hidden_select makes an unreadable note upsert a delete for this reader.
    return entry.table_name === 'hub_note' ? [{ ...base, op: 'delete' as const }] : []
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
  client: SQL,
  identity: TaskIdentity,
  input: Parameters<typeof readHostedChangesInTransaction>[2],
) {
  return client.begin(async (tx) => {
    // Head, entries, and rows share one snapshot, so a returned row is never newer than next.
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
    await bindTenant(tx, identity)
    return readHostedChangesInTransaction(tx, identity, input)
  })
}

type RecordChangeEntry = {
  seq: bigint
  table: string
  rowId: string
  op: 'upsert' | 'delete'
  at: string
}

type RecordChangeLogRow = {
  seq: string | number | bigint
  table_name: string
  row_id: string
  op: 'upsert' | 'delete'
  at: string | Date
  below_cutoff: boolean
}

const asBigInt = (value: string | number | bigint) => BigInt(value)

async function readRecordChangesInTransaction(tx: SQL, after: bigint, limit: number) {
  const metadata = rows<{ horizon: string | number | bigint; newest: string | number | bigint }>(
    await tx`SELECT
      (SELECT seq FROM record_change_horizon WHERE singleton)::text AS horizon,
      COALESCE((SELECT max(seq) FROM record_change), 0)::text AS newest`,
  )[0]!
  const horizon = asBigInt(metadata.horizon)
  const newest = asBigInt(metadata.newest)
  if (after < horizon) {
    return {
      resetRequired: true as const,
      horizon,
      cursor: horizon,
      lag: newest > horizon ? newest - horizon : 0n,
    }
  }

  const candidates = rows<RecordChangeLogRow>(
    await tx`SELECT seq::text, table_name, row_id::text, op, at,
      xid < pg_snapshot_xmin(pg_current_snapshot()) AS below_cutoff
    FROM record_change
    WHERE seq > ${after}
    ORDER BY seq
    LIMIT ${limit}`,
  )
  const blockedAt = candidates.findIndex((row) => !row.below_cutoff)
  const selected = blockedAt === -1 ? candidates : candidates.slice(0, blockedAt)
  const changes: RecordChangeEntry[] = selected.map((row) => ({
    seq: asBigInt(row.seq),
    table: row.table_name,
    rowId: row.row_id,
    op: row.op,
    at: new Date(row.at).toISOString(),
  }))
  const cursor = changes.at(-1)?.seq ?? after
  return {
    resetRequired: false as const,
    changes,
    cursor,
    lag: newest > cursor ? newest - cursor : 0n,
  }
}

async function readRecordChanges(
  client: SQL,
  identity: TaskIdentity,
  after: bigint,
  limit: number,
) {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
    await bindTenant(tx, identity)
    return readRecordChangesInTransaction(tx, after, limit)
  })
}

export const hostedChangeService = { listHostedChanges, readRecordChanges }
