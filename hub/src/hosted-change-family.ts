import type { Database } from 'bun:sqlite'
import type { HostedChangeRow } from './hosted-record-change-wire.ts'
import type { TaskFetch } from './task-client.ts'
import type { RegisteredTaskSpace, TaskDestinationIdentity } from './task-project-space.ts'

export const classifyHostedChangeDelete = (machineSpace: string | null, logSpace: string) =>
  machineSpace === logSpace ? 'apply' : 'skip'

export type HostedChangeUpsertDecision = { kind: 'no-op' } | { kind: 'changed' }

export const classifyHostedChangeUpsert = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): HostedChangeUpsertDecision => {
  return JSON.stringify(before) === JSON.stringify(after) ? { kind: 'no-op' } : { kind: 'changed' }
}

type HostedChangeRequestOptions = {
  baseUrl?: string
  token?: string | null
  fetch?: TaskFetch
  recordSpace: string
  tables: string
}

export type HostedPreparedPage = {
  apply: Array<(conn: Database) => void>
  skippedForAbsentParent: ReadonlySet<string>
}

export type HostedPreparedChange = {
  table: string
  id: string
  op: 'upsert' | 'delete'
  row?: HostedChangeRow
}

export type HostedPreparedChangePage = { changes: HostedPreparedChange[] }

export type HostedChangeFamily = {
  cursorPrefix: string
  tables: string
  spaces: (
    registered: readonly RegisteredTaskSpace[],
    identity: TaskDestinationIdentity,
  ) => string[]
  fullPull: (
    cursor: string | null,
    options: HostedChangeRequestOptions,
  ) => Promise<{ cursor: string; more: boolean; apply: (conn: Database) => void }>
  preparePage?: (
    page: HostedPreparedChangePage,
    options: HostedChangeRequestOptions,
  ) => Promise<HostedPreparedPage>
  tableOrder: (table: string) => number
  accepts: (table: string) => boolean
  machineRow: (conn: Database, table: string, id: string) => Record<string, unknown> | null
  rowSpace: (conn: Database, table: string, id: string) => string | null
  apply: (conn: Database, table: string, row: HostedChangeRow) => void
  delete: (conn: Database, table: string, id: string) => void
  finish?: (conn: Database) => void
  reportAbsentParentSkips?: true
  failureLabel: string
}
