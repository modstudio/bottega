import type { Database } from 'bun:sqlite'
import type { HostedSpaceChange, HostedSpaceChangePage, TaskFetch } from './task-client.ts'
import type { RegisteredTaskSpace, TaskDestinationIdentity } from './task-project-space.ts'

export type HostedChangeRequestOptions = {
  baseUrl?: string
  token?: string | null
  fetch?: TaskFetch
  recordSpace: string
  tables: string
}

export type HostedChangeFamily = {
  cursorPrefix: string
  tables: string
  spaces: (
    registered: readonly RegisteredTaskSpace[],
    identity: TaskDestinationIdentity,
  ) => string[]
  fullPull: (options: HostedChangeRequestOptions) => Promise<(conn: Database) => void>
  preparePage?: (
    page: HostedSpaceChangePage,
    options: HostedChangeRequestOptions,
  ) => Promise<Array<(conn: Database) => void>>
  tableOrder: (table: string) => number
  accepts: (table: string) => boolean
  machineRow: (conn: Database, table: string, id: string) => Record<string, unknown> | null
  rowSpace: (conn: Database, table: string, id: string) => string | null
  apply: (conn: Database, table: string, row: NonNullable<HostedSpaceChange['row']>) => void
  delete: (conn: Database, table: string, id: string) => void
  finish?: (conn: Database) => void
  failureLabel: string
}
