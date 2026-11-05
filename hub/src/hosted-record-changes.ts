// concern: hosted-record-changes
/** Materializes the hub portion of the shared record change feed through the existing serializers. */
import type { SQL } from 'bun'
import {
  type RecordChangeCursor,
  type RecordChangeEntry,
  type RecordChangeReadPage,
  readRecordChanges,
} from '../../shared/record/record-changes.ts'
import { READABLE_HUB_CHANGES, type ReadableHubChangeTable } from './hosted-changes.ts'
import type { TaskIdentity } from './hosted-tenant.ts'

export const HOSTED_RECORD_CHANGE_TABLES = Object.keys(
  READABLE_HUB_CHANGES,
) as ReadableHubChangeTable[]

type FeedPage = Exclude<RecordChangeReadPage, { resetRequired: true }>
export type HostedRecordChange = {
  table: ReadableHubChangeTable
  id: string
  space: string
  op: 'upsert' | 'delete'
  row?: unknown
}

function collapsedEntries(changes: readonly RecordChangeEntry[]) {
  const collapsed = new Map<string, RecordChangeEntry>()
  for (const change of changes) collapsed.set(`${change.table}:${change.id}`, change)
  const keys = new Set(collapsed.values())
  return changes.filter((change) => keys.has(change))
}

export async function materializeHostedRecordChangePage(tx: SQL, page: FeedPage) {
  const entries = collapsedEntries(page.changes).filter((entry) =>
    HOSTED_RECORD_CHANGE_TABLES.includes(entry.table as ReadableHubChangeTable),
  )
  const current = new Map<string, unknown>()
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

export type HostedRecordChangeResult = Awaited<ReturnType<typeof readHostedRecordChanges>>
