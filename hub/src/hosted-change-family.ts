import type { Database } from 'bun:sqlite'
import type { HostedSpaceChange, HostedSpaceChangePage, TaskFetch } from './task-client.ts'
import type { RegisteredTaskSpace, TaskDestinationIdentity } from './task-project-space.ts'

export const HOSTED_CHANGE_FAMILIES = ['task', 'note'] as const
export type HostedChangeFamilyName = (typeof HOSTED_CHANGE_FAMILIES)[number]

export const classifyHostedChangeDelete = (machineSpace: string | null, logSpace: string) =>
  machineSpace === logSpace ? 'apply' : 'skip'

export type HostedChangeUpsertDecision =
  | { kind: 'no-op'; differingColumns: [] }
  | { kind: 'changed'; differingColumns: string[] }

export const classifyHostedChangeUpsert = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): HostedChangeUpsertDecision => {
  if (JSON.stringify(before) === JSON.stringify(after))
    return { kind: 'no-op', differingColumns: [] }
  const beforeRow = before ?? {}
  const afterRow = after ?? {}
  const differingColumns = [...new Set([...Object.keys(beforeRow), ...Object.keys(afterRow)])]
    .filter(
      (column) =>
        !(column in beforeRow) ||
        !(column in afterRow) ||
        JSON.stringify(beforeRow[column]) !== JSON.stringify(afterRow[column]),
    )
    .sort()
  return { kind: 'changed', differingColumns }
}

export type HostedChangeRequestOptions = {
  baseUrl?: string
  token?: string | null
  fetch?: TaskFetch
  recordSpace: string
  tables: string
}

export type HostedChangeFamily = {
  evidenceFamily: HostedChangeFamilyName
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
