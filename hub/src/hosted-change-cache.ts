import type { Database } from 'bun:sqlite'
import { db, writeTransaction } from './db.ts'
import type { HostedChangeFamily, HostedChangeRequestOptions } from './hosted-change-family.ts'
import type { HostedAcknowledgement, HostedNote } from './hosted-notes.ts'
import { createHostedTaskChangeFamily } from './hosted-task-change-family.ts'
import {
  applyHostedAcknowledgement,
  applyHostedNote,
  applyHostedNoteRows,
  completeAcknowledgementNotes,
  hostedNotePullRows,
} from './note-cache.ts'
import { notePullSpaces } from './note-project-space.ts'
import { projects } from './projects.ts'
import {
  type HostedSpaceChange,
  type HostedSpaceChangePage,
  hostedSpaceChanges,
  hostedTaskIdentity,
  type TaskFetch,
} from './task-client.ts'
import {
  type RegisteredTaskSpace,
  type TaskDestinationIdentity,
  taskProjectDestination,
} from './task-project-space.ts'

export const HOSTED_NOTE_CHANGES_CURSOR_KEY = 'collect.hosted-note-changes.cursor'
export const MAX_HOSTED_CHANGE_PAGES_PER_PASS = 40

type SpaceCounts = {
  spaceId: string
  upsertsChanged: number
  upsertsNoop: number
  deletesApplied: number
  deletesSkipped: number
}
export type HostedChangeLegReport = Omit<SpaceCounts, 'spaceId'> & { spaces: SpaceCounts[] }
type PullOptions = {
  baseUrl?: string
  token?: string | null
  fetch?: TaskFetch
  registeredProjects?: readonly RegisteredTaskSpace[]
}

const emptyCounts = (spaceId: string): SpaceCounts => ({
  spaceId,
  upsertsChanged: 0,
  upsertsNoop: 0,
  deletesApplied: 0,
  deletesSkipped: 0,
})
const addCounts = (left: SpaceCounts, right: SpaceCounts): SpaceCounts => ({
  spaceId: left.spaceId,
  upsertsChanged: left.upsertsChanged + right.upsertsChanged,
  upsertsNoop: left.upsertsNoop + right.upsertsNoop,
  deletesApplied: left.deletesApplied + right.deletesApplied,
  deletesSkipped: left.deletesSkipped + right.deletesSkipped,
})
function sumCounts(spaces: SpaceCounts[]): HostedChangeLegReport {
  return spaces.reduce<HostedChangeLegReport>(
    (totals, space) => ({
      upsertsChanged: totals.upsertsChanged + space.upsertsChanged,
      upsertsNoop: totals.upsertsNoop + space.upsertsNoop,
      deletesApplied: totals.deletesApplied + space.deletesApplied,
      deletesSkipped: totals.deletesSkipped + space.deletesSkipped,
      spaces,
    }),
    { upsertsChanged: 0, upsertsNoop: 0, deletesApplied: 0, deletesSkipped: 0, spaces },
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

function readCursor(family: HostedChangeFamily, spaceId: string): number | null {
  const value = db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
    .get(`${family.cursorPrefix}.${spaceId}`)?.value
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return null
  const cursor = Number(value)
  return Number.isSafeInteger(cursor) ? cursor : null
}
function storeCursor(conn: Database, family: HostedChangeFamily, spaceId: string, cursor: number) {
  conn
    .query(
      'INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(`${family.cursorPrefix}.${spaceId}`, String(cursor))
}
export const classifyHostedChangeDelete = (machineSpace: string | null, logSpace: string) =>
  machineSpace === logSpace ? 'apply' : 'skip'

export const classifyHostedChangeUpsert = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
) => (JSON.stringify(before) === JSON.stringify(after) ? 'no-op' : 'changed')

function applyOneChange(
  conn: Database,
  change: HostedSpaceChange,
  spaceId: string,
  family: HostedChangeFamily,
  counts: SpaceCounts,
) {
  if (!family.accepts(change.table)) return
  if (change.op === 'delete') {
    const decision = classifyHostedChangeDelete(
      family.rowSpace(conn, change.table, change.id),
      spaceId,
    )
    if (decision === 'skip') counts.deletesSkipped += 1
    else {
      family.delete(conn, change.table, change.id)
      counts.deletesApplied += 1
    }
    return
  }
  if (change.row === undefined) {
    counts.upsertsNoop += 1
    return
  }
  const before = family.machineRow(conn, change.table, change.id)
  family.apply(conn, change.table, change.row)
  const after = family.machineRow(conn, change.table, change.id)
  if (classifyHostedChangeUpsert(before, after) === 'no-op') counts.upsertsNoop += 1
  else counts.upsertsChanged += 1
}

function applyPage(
  conn: Database,
  page: HostedSpaceChangePage,
  spaceId: string,
  family: HostedChangeFamily,
  prepared: Array<(conn: Database) => void>,
) {
  const counts = emptyCounts(spaceId)
  for (const apply of prepared) apply(conn)
  const changes = page.changes
    .map((change, index) => ({ change, index }))
    .sort(
      (left, right) =>
        family.tableOrder(left.change.table) - family.tableOrder(right.change.table) ||
        left.index - right.index,
    )
  for (const { change } of changes) {
    applyOneChange(conn, change, spaceId, family, counts)
  }
  family.finish?.(conn)
  return counts
}

async function startSpace(
  family: HostedChangeFamily,
  spaceId: string,
  options: HostedChangeRequestOptions,
  head?: number,
) {
  const sequence = head ?? (await hostedSpaceChanges(0, { ...options, limit: 1 })).head
  const applySnapshot = await family.fullPull(options)
  writeTransaction((conn) => {
    applySnapshot(conn)
    storeCursor(conn, family, spaceId, sequence)
  })
  return emptyCounts(spaceId)
}
async function followSpace(
  family: HostedChangeFamily,
  spaceId: string,
  after: number,
  options: HostedChangeRequestOptions,
) {
  let counts = emptyCounts(spaceId)
  let cursor = after
  for (let page = 0; page < MAX_HOSTED_CHANGE_PAGES_PER_PASS; page++) {
    const response = await hostedSpaceChanges(cursor, options)
    if (response.resetRequired)
      return addCounts(counts, await startSpace(family, spaceId, options, response.head))
    const prepared = (await family.preparePage?.(response, options)) ?? []
    const pageCounts = writeTransaction((conn) => {
      const applied = applyPage(conn, response, spaceId, family, prepared)
      storeCursor(conn, family, spaceId, response.next)
      return applied
    })
    counts = addCounts(counts, pageCounts)
    cursor = response.next
    if (!response.more) break
  }
  return counts
}
async function pullFamily(
  family: HostedChangeFamily,
  options: PullOptions,
  identity: TaskDestinationIdentity,
  registered: readonly RegisteredTaskSpace[],
) {
  const shared = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  const results: SpaceCounts[] = []
  const failures: string[] = []
  for (const spaceId of family.spaces(registered, identity)) {
    const requestOptions = { ...shared, recordSpace: spaceId, tables: family.tables }
    try {
      const cursor = readCursor(family, spaceId)
      results.push(
        cursor === null
          ? await startSpace(family, spaceId, requestOptions)
          : await followSpace(family, spaceId, cursor, requestOptions),
      )
    } catch (cause) {
      failures.push(`${spaceId}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (failures.length)
    throw new Error(`${family.failureLabel} pulls failed: ${failures.join('; ')}`)
  return sumCounts(results)
}

const NOTE_TABLES = 'hub_note,hub_note_acknowledgement'
const isNoteTable = (table: string) => table === 'hub_note' || table === 'hub_note_acknowledgement'
const machineTable = (table: string) => (table === 'hub_note' ? 'note' : 'note_acknowledgement')
function noteFamily(
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
): HostedChangeFamily {
  const projectSpace = (project: string) => {
    const destination = taskProjectDestination(project, registered, identity)
    return 'destinationSpaceId' in destination ? destination.destinationSpaceId : null
  }
  return {
    cursorPrefix: HOSTED_NOTE_CHANGES_CURSOR_KEY,
    tables: NOTE_TABLES,
    spaces: notePullSpaces,
    fullPull: async (options) => {
      const snapshot = await hostedNotePullRows(null, options)
      return (conn) => applyHostedNoteRows(conn, snapshot)
    },
    preparePage: async (page, options) => {
      const noteChanges = page.changes
        .filter((change) => change.table === 'hub_note')
        .map((change) => ({
          id: change.id,
          deleted:
            change.op === 'delete' || Boolean((change.row as HostedNote | undefined)?.deleted_at),
        }))
      const acknowledgements = page.changes
        .filter((change) => change.table === 'hub_note_acknowledgement' && change.op === 'upsert')
        .map((change) => change.row as HostedAcknowledgement)
      const fetched = await completeAcknowledgementNotes(noteChanges, acknowledgements, options)
      return fetched.map((note) => (conn: Database) => applyHostedNote(conn, note))
    },
    tableOrder: (table) => (table === 'hub_note' ? 0 : 1),
    accepts: isNoteTable,
    machineRow: (conn, table, id) =>
      conn
        .query<Record<string, unknown>, [string]>(
          `SELECT * FROM ${machineTable(table)} WHERE record_id=?`,
        )
        .get(id) ?? null,
    rowSpace: (conn, table, id) => {
      const project =
        table === 'hub_note'
          ? conn
              .query<{ project: string }, [string]>('SELECT project FROM note WHERE record_id=?')
              .get(id)?.project
          : conn
              .query<{ project: string }, [string]>(
                'SELECT n.project FROM note_acknowledgement a JOIN note n ON n.record_id=a.note_record_id WHERE a.record_id=?',
              )
              .get(id)?.project
      return project ? projectSpace(project) : null
    },
    apply: (conn, table, row) => {
      if (table === 'hub_note') applyHostedNote(conn, row as HostedNote)
      else applyHostedAcknowledgement(conn, row as HostedAcknowledgement)
    },
    delete: (conn, table, id) =>
      conn.query(`DELETE FROM ${machineTable(table)} WHERE record_id=?`).run(id),
    failureLabel: 'hosted note change',
  }
}

async function pullChanges(
  makeFamily: (
    registered: readonly RegisteredTaskSpace[],
    identity: TaskDestinationIdentity,
  ) => HostedChangeFamily,
  options: PullOptions,
) {
  const shared = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  const identity = await hostedTaskIdentity(shared)
  if (identity.capabilities?.spaceChanges !== true) return null
  const registered = options.registeredProjects ?? projects()
  return pullFamily(makeFamily(registered, identity), options, identity, registered)
}
export const pullHostedTaskChanges = (options: PullOptions = {}) =>
  pullChanges(createHostedTaskChangeFamily, options)
export const pullHostedNoteChanges = (options: PullOptions = {}) => pullChanges(noteFamily, options)
