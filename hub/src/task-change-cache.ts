import type { Database } from 'bun:sqlite'
import { db, writeTransaction } from './db.ts'
import { projects } from './projects.ts'
import {
  applyHostedChangeUpsert,
  applyHostedTaskRows,
  deleteHostedChangeRow,
  type HostedTaskChangeTable,
  hostedChangeMachineRow,
  hostedChangeRowProject,
  reconcileParentRecordIds,
} from './task-cache.ts'
import {
  type HostedSpaceChange,
  type HostedSpaceChangePage,
  hostedSpaceChanges,
  hostedTaskChanges,
  hostedTaskIdentity,
  type TaskFetch,
} from './task-client.ts'
import {
  type RegisteredTaskSpace,
  type TaskDestinationIdentity,
  taskProjectDestination,
  taskPullSpaces,
} from './task-project-space.ts'

export const HOSTED_CHANGES_CURSOR_KEY = 'collect.hosted-changes.cursor'
export const MAX_HOSTED_CHANGE_PAGES_PER_PASS = 40

const TASK_CHANGE_TABLES = new Set<string>([
  'hub_task',
  'hub_task_comment',
  'hub_task_document',
  'hub_task_status_event',
])

type HostedChangeSpaceCounts = {
  spaceId: string
  upsertsChanged: number
  upsertsNoop: number
  deletesApplied: number
  deletesSkipped: number
}

export type HostedChangeLegReport = {
  upsertsChanged: number
  upsertsNoop: number
  deletesApplied: number
  deletesSkipped: number
  spaces: HostedChangeSpaceCounts[]
}

type ChangePullOptions = {
  baseUrl?: string
  token?: string | null
  fetch?: TaskFetch
  registeredProjects?: readonly RegisteredTaskSpace[]
}

const cursorKeyFor = (spaceId: string) => `${HOSTED_CHANGES_CURSOR_KEY}.${spaceId}`

const emptyCounts = (spaceId: string): HostedChangeSpaceCounts => ({
  spaceId,
  upsertsChanged: 0,
  upsertsNoop: 0,
  deletesApplied: 0,
  deletesSkipped: 0,
})

function addCounts(
  left: HostedChangeSpaceCounts,
  right: HostedChangeSpaceCounts,
): HostedChangeSpaceCounts {
  return {
    spaceId: left.spaceId,
    upsertsChanged: left.upsertsChanged + right.upsertsChanged,
    upsertsNoop: left.upsertsNoop + right.upsertsNoop,
    deletesApplied: left.deletesApplied + right.deletesApplied,
    deletesSkipped: left.deletesSkipped + right.deletesSkipped,
  }
}

function sumCounts(spaces: HostedChangeSpaceCounts[]): HostedChangeLegReport {
  return spaces.reduce<HostedChangeLegReport>(
    (totals, space) => ({
      upsertsChanged: totals.upsertsChanged + space.upsertsChanged,
      upsertsNoop: totals.upsertsNoop + space.upsertsNoop,
      deletesApplied: totals.deletesApplied + space.deletesApplied,
      deletesSkipped: totals.deletesSkipped + space.deletesSkipped,
      spaces,
    }),
    {
      upsertsChanged: 0,
      upsertsNoop: 0,
      deletesApplied: 0,
      deletesSkipped: 0,
      spaces,
    },
  )
}

export function hostedChangeLegLine(report: HostedChangeLegReport): string {
  return report.spaces
    .map(
      (space) =>
        `${space.spaceId} ${space.upsertsChanged} changed, ${space.upsertsNoop} no-op, ${space.deletesApplied} deleted, ${space.deletesSkipped} skipped`,
    )
    .join('; ')
}

function hostedChangeDeleteAction(rowSpaceId: string | null, logSpaceId: string): 'apply' | 'skip' {
  return rowSpaceId === logSpaceId ? 'apply' : 'skip'
}

function isTaskChangeTable(table: string): table is HostedTaskChangeTable {
  return TASK_CHANGE_TABLES.has(table)
}

function readCursor(spaceId: string): number | null {
  const value = db()
    .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`)
    .get(cursorKeyFor(spaceId))?.value
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return null
  const cursor = Number(value)
  return Number.isSafeInteger(cursor) ? cursor : null
}

function storeCursor(conn: Database, spaceId: string, cursor: number) {
  conn
    .query(
      `INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(cursorKeyFor(spaceId), String(cursor))
}

function spaceOfMachineRow(
  conn: Database,
  table: HostedTaskChangeTable,
  id: string,
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
): string | null {
  const project = hostedChangeRowProject(conn, table, id)
  if (project === null) return null
  const destination = taskProjectDestination(project, registered, identity)
  return 'destinationSpaceId' in destination ? destination.destinationSpaceId : null
}

function sameMachineRow(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
) {
  return JSON.stringify(before) === JSON.stringify(after)
}

function applyDelete(
  conn: Database,
  change: HostedSpaceChange,
  spaceId: string,
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
  counts: HostedChangeSpaceCounts,
) {
  if (!isTaskChangeTable(change.table)) return
  const rowSpace = spaceOfMachineRow(conn, change.table, change.id, registered, identity)
  if (hostedChangeDeleteAction(rowSpace, spaceId) === 'skip') {
    counts.deletesSkipped += 1
    return
  }
  deleteHostedChangeRow(conn, change.table, change.id)
  counts.deletesApplied += 1
}

function applyUpsert(conn: Database, change: HostedSpaceChange, counts: HostedChangeSpaceCounts) {
  if (!isTaskChangeTable(change.table) || change.row === undefined) {
    counts.upsertsNoop += 1
    return
  }
  const before = hostedChangeMachineRow(conn, change.table, change.id)
  applyHostedChangeUpsert(conn, change.table, change.row)
  const after = hostedChangeMachineRow(conn, change.table, change.id)
  if (sameMachineRow(before, after)) counts.upsertsNoop += 1
  else counts.upsertsChanged += 1
}

function applyChangePage(
  conn: Database,
  page: HostedSpaceChangePage,
  spaceId: string,
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
): HostedChangeSpaceCounts {
  const counts = emptyCounts(spaceId)
  for (const change of page.changes) {
    if (change.op === 'delete') applyDelete(conn, change, spaceId, registered, identity, counts)
    else applyUpsert(conn, change, counts)
  }
  reconcileParentRecordIds(conn)
  return counts
}

async function startSpaceChanges(
  spaceId: string,
  requestOptions: {
    baseUrl?: string
    token?: string | null
    fetch?: TaskFetch
    recordSpace: string
  },
  head?: number,
): Promise<HostedChangeSpaceCounts> {
  const sequence = head ?? (await hostedSpaceChanges(0, { ...requestOptions, limit: 1 })).head
  const snapshot = await hostedTaskChanges(null, requestOptions)
  writeTransaction((conn) => {
    applyHostedTaskRows(conn, snapshot)
    storeCursor(conn, spaceId, sequence)
  })
  return emptyCounts(spaceId)
}

async function followSpaceChanges(
  spaceId: string,
  after: number,
  requestOptions: {
    baseUrl?: string
    token?: string | null
    fetch?: TaskFetch
    recordSpace: string
  },
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
): Promise<HostedChangeSpaceCounts> {
  let counts = emptyCounts(spaceId)
  let cursor = after
  for (let page = 0; page < MAX_HOSTED_CHANGE_PAGES_PER_PASS; page++) {
    const response = await hostedSpaceChanges(cursor, requestOptions)
    if (response.resetRequired) {
      return addCounts(counts, await startSpaceChanges(spaceId, requestOptions, response.head))
    }
    const pageCounts = writeTransaction((conn) => {
      const applied = applyChangePage(conn, response, spaceId, registered, identity)
      storeCursor(conn, spaceId, response.next)
      return applied
    })
    counts = addCounts(counts, pageCounts)
    cursor = response.next
    if (!response.more) break
  }
  return counts
}

async function pullSpaceChanges(
  spaceId: string,
  options: ChangePullOptions,
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
): Promise<HostedChangeSpaceCounts> {
  const requestOptions = {
    baseUrl: options.baseUrl,
    token: options.token,
    fetch: options.fetch,
    recordSpace: spaceId,
  }
  const cursor = readCursor(spaceId)
  if (cursor === null) return startSpaceChanges(spaceId, requestOptions)
  return followSpaceChanges(spaceId, cursor, requestOptions, registered, identity)
}

export async function pullHostedTaskChanges(
  options: ChangePullOptions = {},
): Promise<HostedChangeLegReport | null> {
  const requestOptions = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  const identity = await hostedTaskIdentity(requestOptions)
  if (identity.capabilities?.spaceChanges !== true) return null
  const registered = options.registeredProjects ?? projects()
  const spaces = taskPullSpaces(registered, identity)
  const results: HostedChangeSpaceCounts[] = []
  const failures: string[] = []
  for (const spaceId of spaces) {
    try {
      results.push(await pullSpaceChanges(spaceId, options, registered, identity))
    } catch (cause) {
      failures.push(`${spaceId}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (failures.length) throw new Error(`hosted change pulls failed: ${failures.join('; ')}`)
  return sumCounts(results)
}
