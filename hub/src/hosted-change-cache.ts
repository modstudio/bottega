import type { Database } from 'bun:sqlite'
import { db, writeTransaction } from './db.ts'
import {
  classifyHostedChangeDelete,
  classifyHostedChangeUpsert,
  type HostedChangeFamily,
  type HostedPreparedChange,
  type HostedPreparedChangePage,
  type HostedPreparedPage,
} from './hosted-change-family.ts'
import type { HostedAcknowledgement, HostedNote } from './hosted-notes.ts'
import { createHostedSendChangeFamily } from './hosted-send-change-family.ts'
import { createHostedTaskChangeFamily } from './hosted-task-change-family.ts'
import {
  applyHostedAcknowledgement,
  applyHostedNote,
  applyHostedNoteRows,
  completeAcknowledgementNotes,
  hostedNotePullRows,
} from './note-cache.ts'
import { notePullSpaces } from './note-project-space.ts'
import {
  HOSTED_MACHINE_TABLES,
  pendingEditSkipsPull,
  pendingHostedEdit,
  type ReconciledHostedTable,
  reconcilePulledRow,
} from './pending-hosted-edit.ts'
import { projects } from './projects.ts'
import {
  type HostedRecordChange,
  type HostedRecordChangePage,
  hostedRecordChanges,
  hostedTaskIdentity,
  type TaskFetch,
} from './task-client.ts'
import {
  type RegisteredTaskSpace,
  type TaskDestinationIdentity,
  taskProjectDestination,
} from './task-project-space.ts'

const HOSTED_NOTE_CHANGES_CURSOR_KEY = 'collect.hosted-note-changes.cursor'
const MAX_HOSTED_CHANGE_PAGES_PER_PASS = 40

type SpaceCounts = {
  spaceId: string
  upsertsChanged: number
  upsertsNoop: number
  deletesApplied: number
  deletesSkipped: number
  absentParentSkipped: number
  resets: number
  outsidePullSetSkipped?: number
}
export type HostedChangeLegReport = Omit<SpaceCounts, 'spaceId'> & {
  spaces: SpaceCounts[]
  reportAbsentParentSkips?: true
}
export type HostedChangesReport = {
  families: Array<{ name: string; report: HostedChangeLegReport }>
}
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
  absentParentSkipped: 0,
  resets: 0,
})
function sumCounts(spaces: SpaceCounts[], reportAbsentParentSkips: boolean): HostedChangeLegReport {
  const totals = spaces.reduce<HostedChangeLegReport>(
    (totals, space) => ({
      upsertsChanged: totals.upsertsChanged + space.upsertsChanged,
      upsertsNoop: totals.upsertsNoop + space.upsertsNoop,
      deletesApplied: totals.deletesApplied + space.deletesApplied,
      deletesSkipped: totals.deletesSkipped + space.deletesSkipped,
      absentParentSkipped: totals.absentParentSkipped + space.absentParentSkipped,
      resets: totals.resets + space.resets,
      outsidePullSetSkipped:
        (totals.outsidePullSetSkipped ?? 0) + (space.outsidePullSetSkipped ?? 0),
      spaces,
    }),
    {
      upsertsChanged: 0,
      upsertsNoop: 0,
      deletesApplied: 0,
      deletesSkipped: 0,
      absentParentSkipped: 0,
      resets: 0,
      spaces,
    },
  )
  return reportAbsentParentSkips ? { ...totals, reportAbsentParentSkips: true } : totals
}
export function hostedChangeLegLine(report: HostedChangeLegReport): string {
  return report.spaces
    .map(
      (space) =>
        `${space.spaceId} ${space.upsertsChanged} changed, ${space.upsertsNoop} no-op, ${space.deletesApplied} deleted, ${space.deletesSkipped} skipped, ${
          report.reportAbsentParentSkips
            ? `${space.absentParentSkipped} absent-parent skipped, `
            : ''
        }${space.resets} reset`,
    )
    .join('; ')
}

function applyDelete(conn: Database, change: HostedPreparedChange, family: HostedChangeFamily) {
  if (Object.hasOwn(HOSTED_MACHINE_TABLES, change.table))
    return reconcilePulledRow(conn, {
      table: change.table as ReconciledHostedTable,
      id: change.id,
      operation: 'delete',
      current: () => family.machineRow(conn, change.table, change.id),
      apply: () => {},
      remove: () =>
        change.row
          ? family.apply(conn, change.table, change.row)
          : family.delete(conn, change.table, change.id),
    })
  family.delete(conn, change.table, change.id)
  return { kind: 'deleted' as const }
}

function applyDeleteChange(
  conn: Database,
  change: HostedPreparedChange,
  spaceId: string,
  family: HostedChangeFamily,
  counts: SpaceCounts,
) {
  const decision = classifyHostedChangeDelete(
    family.rowSpace(conn, change.table, change.id),
    spaceId,
  )
  if (decision === 'skip') {
    counts.deletesSkipped += 1
    return
  }
  const reconciled = applyDelete(conn, change, family)
  if (reconciled.kind === 'skipped') counts.deletesSkipped += 1
  else counts.deletesApplied += 1
}

function applyOneChange(
  conn: Database,
  change: HostedPreparedChange,
  spaceId: string,
  family: HostedChangeFamily,
  counts: SpaceCounts,
) {
  if (!family.accepts(change.table)) return
  if (
    change.op === 'upsert' &&
    Object.hasOwn(HOSTED_MACHINE_TABLES, change.table) &&
    (change.row as { deleted_at?: string | null } | undefined)?.deleted_at
  ) {
    applyDeleteChange(conn, { ...change, op: 'delete' }, spaceId, family, counts)
    return
  }
  const pending = pendingHostedEdit(conn, change.table, change.id)
  if (change.op !== 'delete' && pendingEditSkipsPull(pending)) {
    counts.upsertsNoop += 1
    return
  }
  if (change.op === 'delete') {
    applyDeleteChange(conn, change, spaceId, family, counts)
    return
  }
  if (change.row === undefined) {
    counts.upsertsNoop += 1
    return
  }
  const reconciled = Object.hasOwn(HOSTED_MACHINE_TABLES, change.table)
    ? reconcilePulledRow(conn, {
        table: change.table as ReconciledHostedTable,
        id: change.id,
        operation: 'upsert',
        current: () => family.machineRow(conn, change.table, change.id),
        apply: () => family.apply(conn, change.table, change.row!),
        remove: () => family.delete(conn, change.table, change.id),
      })
    : (() => {
        const before = family.machineRow(conn, change.table, change.id)
        family.apply(conn, change.table, change.row!)
        return {
          kind: 'upserted' as const,
          before,
          after: family.machineRow(conn, change.table, change.id),
        }
      })()
  if (reconciled.kind === 'skipped') {
    counts.upsertsNoop += 1
    return
  }
  const { before, after } = reconciled
  const decision = classifyHostedChangeUpsert(before, after)
  if (decision.kind === 'no-op') counts.upsertsNoop += 1
  else counts.upsertsChanged += 1
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
    fullPull: async (cursor, options) => {
      const snapshot = await hostedNotePullRows(cursor, options)
      return {
        cursor: snapshot.cursor,
        more: snapshot.more ?? false,
        apply: (conn) => applyHostedNoteRows(conn, snapshot),
      }
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
      return {
        apply: fetched.map((note) => (conn: Database) => applyHostedNote(conn, note)),
        skippedForAbsentParent: new Set<string>(),
      }
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

const FEED_CURSOR = 'collect.hosted-record-changes.cursor'
const FEED_SPACES = 'collect.hosted-record-changes.spaces'
const FEED_PENDING = 'collect.hosted-record-changes.pending'
type FamilyName = 'task' | 'note' | 'send'
type FeedFamily = { name: FamilyName; family: HostedChangeFamily; spaces: string[] }

const setting = (key: string): string | undefined =>
  db().query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?').get(key)?.value
const transactionSetting = (conn: Database, key: string): string | undefined =>
  conn.query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?').get(key)?.value
const putSetting = (conn: Database, key: string, value: string) =>
  conn
    .query(
      'INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, value)
const jsonSetting = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(setting(key) ?? '') as T
  } catch {
    return fallback
  }
}
const pair = (name: FamilyName, space: string) => `${name}:${space}`
const snapshotCursorKey = (feed: FeedFamily, space: string) =>
  `collect.hosted-record-changes.snapshot.${feed.name}.${space}`

function feedFamilies(
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
): FeedFamily[] {
  const values: Array<[FamilyName, HostedChangeFamily]> = [
    ['task', createHostedTaskChangeFamily(registered, identity)],
    ['note', noteFamily(registered, identity)],
    ['send', createHostedSendChangeFamily(registered, identity)],
  ]
  return values.map(([name, family]) => ({
    name,
    family,
    spaces: family.spaces(registered, identity),
  }))
}

async function runFullPull(feed: FeedFamily, space: string, shared: PullOptions) {
  const key = snapshotCursorKey(feed, space)
  let cursor = setting(key) ?? null
  for (;;) {
    const page = await feed.family.fullPull(cursor, {
      ...shared,
      recordSpace: space,
      tables: feed.family.tables,
    })
    if (page.more && page.cursor === cursor)
      throw new Error('hosted snapshot cursor did not advance')
    writeTransaction((conn) => {
      page.apply(conn)
      if (page.more) putSetting(conn, key, page.cursor)
      else conn.query('DELETE FROM setting WHERE key=?').run(key)
    })
    cursor = page.cursor
    if (!page.more) return
  }
}

function countFor(counts: Map<string, SpaceCounts>, name: FamilyName, space: string) {
  const key = pair(name, space)
  let value = counts.get(key)
  if (!value) {
    value = emptyCounts(space)
    value.outsidePullSetSkipped = 0
    counts.set(key, value)
  }
  return value
}

function pageFor(changes: HostedRecordChange[]): HostedPreparedChangePage {
  return { changes }
}

async function applyFeedPage(
  response: HostedRecordChangePage,
  after: string,
  families: FeedFamily[],
  pending: Set<string>,
  counts: Map<string, SpaceCounts>,
  shared: PullOptions,
  remembered: Record<string, string[]>,
) {
  const prepared = new Map<string, HostedPreparedPage>()
  const subsets = new Map<FamilyName, HostedRecordChange[]>()
  for (const feed of families) {
    const subset: HostedRecordChange[] = []
    for (const change of response.changes.filter((entry) => feed.family.accepts(entry.table))) {
      if (!feed.spaces.includes(change.space)) {
        countFor(counts, feed.name, change.space).outsidePullSetSkipped! += 1
      } else subset.push(change)
    }
    subsets.set(feed.name, subset)
    for (const space of feed.spaces) {
      const spaceSubset = subset.filter((change) => change.space === space)
      prepared.set(
        pair(feed.name, space),
        (await feed.family.preparePage?.(pageFor(spaceSubset), {
          ...shared,
          recordSpace: space,
          tables: feed.family.tables,
        })) ?? { apply: [], skippedForAbsentParent: new Set() },
      )
    }
  }
  writeTransaction((conn) => {
    if (transactionSetting(conn, FEED_CURSOR) !== after)
      throw new Error(
        'hosted change cursor changed while applying a page; another collector is writing this store',
      )
    for (const feed of families) {
      for (const space of feed.spaces)
        for (const apply of prepared.get(pair(feed.name, space))!.apply) apply(conn)
      const ordered = subsets
        .get(feed.name)!
        .map((change, index) => ({ change, index }))
        .sort(
          (a, b) =>
            feed.family.tableOrder(a.change.table) - feed.family.tableOrder(b.change.table) ||
            a.index - b.index,
        )
      for (const { change } of ordered) {
        const familyCounts = countFor(counts, feed.name, change.space)
        const prep = prepared.get(pair(feed.name, change.space))!
        if (prep.skippedForAbsentParent.has(`${change.table}:${change.id}`)) {
          familyCounts.absentParentSkipped += 1
          pending.add(pair(feed.name, change.space))
        } else applyOneChange(conn, change, change.space, feed.family, familyCounts)
      }
    }
    putSetting(conn, FEED_PENDING, JSON.stringify([...pending].sort()))
    putSetting(conn, FEED_SPACES, JSON.stringify(remembered))
    putSetting(conn, FEED_CURSOR, response.cursor)
  })
}

type FeedPass = {
  shared: PullOptions
  families: FeedFamily[]
  remembered: Record<string, string[]>
  pending: Set<string>
  counts: Map<string, SpaceCounts>
  cursor: string | undefined
}

async function prepareFeedPass(options: PullOptions): Promise<FeedPass> {
  const shared = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  const identity = await hostedTaskIdentity(shared)
  if (identity.capabilities?.recordChanges !== true)
    throw new Error(
      'the hosted hub does not serve the record change feed; release the hosted hub at or after the version that does',
    )
  const registered = options.registeredProjects ?? projects()
  const families = feedFamilies(registered, identity)
  const previous = jsonSetting<Record<string, string[]>>(FEED_SPACES, {})
  const remembered = Object.fromEntries(families.map((feed) => [feed.name, feed.spaces]))
  const validPairs = new Set(
    families.flatMap((feed) => feed.spaces.map((space) => pair(feed.name, space))),
  )
  const pending = new Set(
    jsonSetting<string[]>(FEED_PENDING, []).filter((value) => validPairs.has(value)),
  )
  for (const feed of families)
    for (const space of feed.spaces)
      if (!(previous[feed.name] ?? []).includes(space)) pending.add(pair(feed.name, space))
  return { shared, families, remembered, pending, counts: new Map(), cursor: setting(FEED_CURSOR) }
}

async function establishFeedCursor(pass: FeedPass) {
  if (pass.cursor) return
  const reset = await hostedRecordChanges(undefined, pass.shared)
  if (!('reset' in reset))
    throw new Error('hosted change feed did not provide a reset cursor for an uninitialized cache')
  pass.cursor = reset.reset.cursor
  pass.pending.clear()
  for (const feed of pass.families)
    for (const space of feed.spaces) {
      pass.pending.add(pair(feed.name, space))
      countFor(pass.counts, feed.name, space).resets += 1
    }
}

async function runPendingPulls(pass: FeedPass): Promise<string[]> {
  const failures: string[] = []
  for (const value of [...pass.pending]) {
    const split = value.indexOf(':')
    const name = value.slice(0, split) as FamilyName
    const space = value.slice(split + 1)
    const feed = pass.families.find((item) => item.name === name)!
    try {
      await runFullPull(feed, space, pass.shared)
      pass.pending.delete(value)
      writeTransaction((conn) =>
        putSetting(conn, FEED_PENDING, JSON.stringify([...pass.pending].sort())),
      )
    } catch (cause) {
      failures.push(`${value}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  return failures
}

function storeInitialFeedState(pass: FeedPass) {
  if (setting(FEED_CURSOR) !== undefined) return
  writeTransaction((conn) => {
    putSetting(conn, FEED_PENDING, JSON.stringify([...pass.pending].sort()))
    putSetting(conn, FEED_SPACES, JSON.stringify(pass.remembered))
    putSetting(conn, FEED_CURSOR, pass.cursor!)
  })
}

async function followFeed(pass: FeedPass): Promise<'done' | 'reset'> {
  for (let page = 0; page < MAX_HOSTED_CHANGE_PAGES_PER_PASS; page++) {
    const response = await hostedRecordChanges(pass.cursor!, pass.shared)
    if ('reset' in response) {
      writeTransaction((conn) => {
        conn.query('DELETE FROM setting WHERE key IN (?,?)').run(FEED_CURSOR, FEED_PENDING)
      })
      pass.cursor = undefined
      return 'reset'
    }
    await applyFeedPage(
      response,
      pass.cursor!,
      pass.families,
      pass.pending,
      pass.counts,
      pass.shared,
      pass.remembered,
    )
    pass.cursor = response.cursor
    if (!response.more) return 'done'
  }
  return 'done'
}

function finishFeed(pass: FeedPass): HostedChangesReport {
  writeTransaction((conn) => {
    for (const feed of pass.families) feed.family.finish?.(conn)
  })
  return {
    families: pass.families.map((feed) => ({
      name: feed.name,
      report: sumCounts(
        [...pass.counts.entries()]
          .filter(([key]) => key.startsWith(`${feed.name}:`))
          .map(([, counts]) => counts),
        feed.family.reportAbsentParentSkips === true,
      ),
    })),
  }
}

export async function pullHostedChanges(options: PullOptions = {}): Promise<HostedChangesReport> {
  const pass = await prepareFeedPass(options)
  let restarted = false
  for (;;) {
    await establishFeedCursor(pass)
    const failures = await runPendingPulls(pass)
    storeInitialFeedState(pass)
    if ((await followFeed(pass)) === 'reset') {
      if (restarted) throw new Error('hosted change feed reset more than once in one pass')
      restarted = true
      continue
    }
    const result = finishFeed(pass)
    if (failures.length) throw new Error(`hosted full pulls failed: ${failures.join('; ')}`)
    return result
  }
}

export function hostedChangesLines(report: HostedChangesReport): string {
  return report.families
    .map(({ name, report: family }) =>
      family.spaces
        .map((space) => {
          const values = [
            space.upsertsChanged ? `${space.upsertsChanged} changed` : '',
            space.upsertsNoop ? `${space.upsertsNoop} no-op` : '',
            space.deletesApplied ? `${space.deletesApplied} deleted` : '',
            space.deletesSkipped ? `${space.deletesSkipped} skipped` : '',
            space.absentParentSkipped ? `${space.absentParentSkipped} absent-parent skipped` : '',
            space.resets ? `${space.resets} reset` : '',
            space.outsidePullSetSkipped
              ? `${space.outsidePullSetSkipped} outside-pull-set skipped`
              : '',
          ].filter(Boolean)
          return values.length ? `${space.spaceId} ${values.join(', ')}` : ''
        })
        .filter(Boolean)
        .map((line) => `${name}: ${line}`)
        .join('\n'),
    )
    .filter(Boolean)
    .join('\n')
}
