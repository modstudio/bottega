import { createHash } from 'node:crypto'
import { jsonBody } from '../../shared/http-json.ts'
import { hasRecordIdShape } from '../../shared/record-id.ts'
import { readRecordSessionToken } from '../../shared/record-session.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import type { DayEvidence, IntervalEvidence } from './hosted-evidence.ts'
import { projects } from './projects.ts'
import {
  assertDayRecordId,
  assertIntervalRecordId,
  assertTargetSpaceIntervalEvidence,
  hostedSignedInUserId,
  hostedTaskIdentity,
} from './task-client.ts'
import {
  partitionProjectRows,
  type RegisteredTaskSpace,
  type TaskDestinationIdentity,
} from './task-project-space.ts'

const TEST_REFUSAL =
  'hub evidence sync refuses a real hosted URL unless a stub is injected in tests'
type SyncFetch = (input: string, init?: RequestInit) => Promise<Response>
type LedgerRow = {
  local_key: string
  content_hash: string
  destination_space_id: string | null
}
type IntervalEntry = { key: string; row: IntervalEvidence }
type RoutedIntervalEntry = IntervalEntry & { project_name: string | null }
type IntervalDelivery = {
  key: string
  hash: string
  row: IntervalEvidence
  destinationSpaceId: string
  acknowledgedSpaceId: string | null
}
type IntervalSyncIssue = { project: string | null; reason: string }

/** Resolve attribution now; callers persist the result and never infer it during push. */
export async function signedInRecordUserId(
  options: { baseUrl?: string; token?: string | null; fetch?: SyncFetch } = {},
): Promise<string | null> {
  const baseUrl = options.baseUrl ?? process.env.HUB_HOSTED_URL
  const token = Object.hasOwn(options, 'token') ? options.token : readRecordSessionToken()
  if (!baseUrl || !token) return null
  return hostedSignedInUserId({ baseUrl, token, fetch: options.fetch })
}

type SyncTablePlan<T> = {
  changed: Array<{ key: string; hash: string; row: T }>
  deleted: string[]
  deleteSkipped: boolean
  localCount: number
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function batches<T>(rows: T[], size = 500): T[][] {
  const result: T[][] = []
  for (let index = 0; index < rows.length; index += size)
    result.push(rows.slice(index, index + size))
  return result
}

function localIntervals() {
  const rows = db()
    .query<IntervalEvidence & { id: string }, []>(
      `SELECT record_id AS id, task_key, project AS project_name, source, agent, job, start_at, end_at,
              claude_tokens, vendor_tokens, vendor_cost_usd, ref, via, open, session_id, user_id
         FROM interval ORDER BY source, ref, start_at`,
    )
    .all()
  return rows.map((row) => ({ key: row.id, row }))
}

function localDays() {
  const rows = db()
    .query<DayEvidence & { id: string }, []>(
      `SELECT record_id AS id, day, claude_tokens, cache_read, messages, tasks, canon_tokens, other_tokens,
              commits, files, lines_product, lines_test, lines_docs, lines_config,
              lines_generated, collected_at
         FROM day ORDER BY day`,
    )
    .all()
  return rows.map((row) => ({ key: row.id, row }))
}

function dayFigureHash(row: DayEvidence): string {
  const { id: _id, collected_at: _collectedAt, ...figures } = row
  return contentHash(figures)
}

function diffDays(rows: ReturnType<typeof localDays>, acknowledgements: LedgerRow[]) {
  const known = new Map(acknowledgements.map((entry) => [entry.local_key, entry.content_hash]))
  const newestDay = rows.reduce<string | null>(
    (newest, entry) => (newest === null || entry.row.day > newest ? entry.row.day : newest),
    null,
  )
  return {
    changed: rows
      .map((entry) => {
        const figureHash = dayFigureHash(entry.row)
        const hash =
          entry.row.day === newestDay
            ? `${figureHash}:${contentHash(entry.row.collected_at)}`
            : figureHash
        return { ...entry, figureHash, hash }
      })
      .filter((entry) => {
        const acknowledged = known.get(entry.key)
        if (entry.row.day === newestDay) return acknowledged !== entry.hash
        return (
          acknowledged !== entry.figureHash && !acknowledged?.startsWith(`${entry.figureHash}:`)
        )
      }),
    deleted: [],
    deleteSkipped: false,
    localCount: rows.length,
  }
}

function ledger(table: string): LedgerRow[] {
  return db()
    .query<LedgerRow, [string]>(
      `SELECT local_key, content_hash, destination_space_id
         FROM record_ledger WHERE table_name=? ORDER BY local_key`,
    )
    .all(table)
}

function intervalDeliveries(
  rows: IntervalEntry[],
  acknowledgements: LedgerRow[],
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
) {
  const known = new Map(acknowledgements.map((row) => [row.local_key, row]))
  const deliveries: IntervalDelivery[] = []
  const partitioned = partitionProjectRows<RoutedIntervalEntry>(
    rows.map((entry) => ({ ...entry, project_name: entry.row.project_name })),
    registered,
    identity,
  )
  for (const [destinationSpaceId, destinationRows] of partitioned.destinations) {
    for (const entry of destinationRows) {
      const hash = contentHash(entry.row)
      const old = known.get(entry.key)
      if (old?.destination_space_id === destinationSpaceId && old.content_hash === hash) continue
      deliveries.push({
        key: entry.key,
        row: entry.row,
        hash,
        destinationSpaceId,
        acknowledgedSpaceId: old?.destination_space_id ?? null,
      })
    }
  }
  const refused = [...partitioned.refusals].map(([project, refusal]) => ({
    project,
    reason: refusal.reason,
  }))
  return { deliveries, refused }
}

async function request(
  fetchImpl: SyncFetch,
  baseUrl: string,
  token: string,
  path: string,
  method: string,
  body: unknown,
  recordSpace?: string,
) {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(recordSpace ? { 'x-record-space': recordSpace } : {}),
    },
    body: JSON.stringify(body),
  })
  const url = `${baseUrl.replace(/\/$/, '')}${path}`
  const bodyResult = await jsonBody(response, url)
  if (!bodyResult.ok)
    throw new Error(
      `hosted evidence refused the response from ${bodyResult.url} (status ${bodyResult.status}, content type ${bodyResult.contentType}): expected JSON. Set HUB_HOSTED_URL and run \`orch record doctor\`.`,
    )
  if (!response.ok) {
    const value = bodyResult.value as Record<string, unknown> | null
    throw new Error(
      `hub hosted evidence ${response.status}${value?.error ? `: ${String(value.error)}` : ''}`,
    )
  }
}

function commitLedger<T>(table: string, plan: SyncTablePlan<T>) {
  const syncedAt = nowIso()
  writeTransaction((conn) => {
    const put = conn.query(
      `INSERT INTO record_ledger (table_name, local_key, content_hash, synced_at)
       VALUES (?,?,?,?) ON CONFLICT(table_name, local_key) DO UPDATE SET
       content_hash=excluded.content_hash, synced_at=excluded.synced_at`,
    )
    const remove = conn.query(`DELETE FROM record_ledger WHERE table_name=? AND local_key=?`)
    for (const row of plan.changed) put.run(table, row.key, row.hash, syncedAt)
    for (const key of plan.deleted) remove.run(table, key)
  })
}

function acknowledgeIntervals(rows: IntervalDelivery[]) {
  if (!rows.length) return
  const syncedAt = nowIso()
  writeTransaction((conn) => {
    const put = conn.query(
      `INSERT INTO record_ledger
         (table_name, local_key, content_hash, synced_at, destination_space_id)
       VALUES ('interval',?,?,?,?) ON CONFLICT(table_name, local_key) DO UPDATE SET
       content_hash=excluded.content_hash, synced_at=excluded.synced_at,
       destination_space_id=excluded.destination_space_id`,
    )
    for (const row of rows) put.run(row.key, row.hash, syncedAt, row.destinationSpaceId)
  })
}

function forgetIntervals(keys: string[]) {
  if (!keys.length) return
  writeTransaction((conn) => {
    const remove = conn.query(
      `DELETE FROM record_ledger WHERE table_name='interval' AND local_key=?`,
    )
    for (const key of keys) remove.run(key)
  })
}

function groupedBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row])
  return result
}

type DeliveryRequest = { fetch: SyncFetch; baseUrl: string; token: string }

async function putIntervalRows(
  rows: IntervalDelivery[],
  destinationSpaceId: string,
  requestOptions: DeliveryRequest,
) {
  await request(
    requestOptions.fetch,
    requestOptions.baseUrl,
    requestOptions.token,
    '/v1/evidence/intervals',
    'PUT',
    { rows: rows.map((row) => row.row) },
    destinationSpaceId,
  )
}

async function deleteIntervalRows(
  keys: string[],
  spaceId: string,
  requestOptions: DeliveryRequest,
) {
  await request(
    requestOptions.fetch,
    requestOptions.baseUrl,
    requestOptions.token,
    '/v1/evidence/intervals',
    'DELETE',
    { ids: keys },
    spaceId,
  )
}

async function deliverIntervalChanges(rows: IntervalDelivery[], requestOptions: DeliveryRequest) {
  const issues: IntervalSyncIssue[] = []
  for (const [destinationSpaceId, destinationRows] of groupedBy(
    rows,
    (row) => row.destinationSpaceId,
  )) {
    try {
      for (const group of batches(destinationRows)) {
        const moved = group.filter(
          (row) =>
            row.acknowledgedSpaceId !== null && row.acknowledgedSpaceId !== row.destinationSpaceId,
        )
        const unmoved = group.filter((row) => !moved.includes(row))
        if (unmoved.length) {
          await putIntervalRows(unmoved, destinationSpaceId, requestOptions)
          acknowledgeIntervals(unmoved)
        }
        for (const [oldSpaceId, movedRows] of groupedBy(moved, (row) => row.acknowledgedSpaceId!)) {
          await deleteIntervalRows(
            movedRows.map((row) => row.key),
            oldSpaceId,
            requestOptions,
          )
          await putIntervalRows(movedRows, destinationSpaceId, requestOptions)
          acknowledgeIntervals(movedRows)
        }
      }
    } catch (error) {
      for (const project of new Set(destinationRows.map((row) => row.row.project_name)))
        issues.push({ project, reason: `delivery-failed: ${(error as Error).message}` })
    }
  }
  return issues
}

async function deleteVanishedIntervals(rows: LedgerRow[], requestOptions: DeliveryRequest) {
  const issues: IntervalSyncIssue[] = []
  for (const [destinationSpaceId, destinationRows] of groupedBy(
    rows,
    (row) => row.destination_space_id!,
  )) {
    try {
      for (const group of batches(destinationRows)) {
        await deleteIntervalRows(
          group.map((row) => row.local_key),
          destinationSpaceId,
          requestOptions,
        )
        forgetIntervals(group.map((row) => row.local_key))
      }
    } catch (error) {
      issues.push({
        project: null,
        reason: `delete-failed for ${destinationSpaceId}: ${(error as Error).message}`,
      })
    }
  }
  return issues
}

export type SyncResult = {
  interval: {
    changed: number
    deleted: number
    deleteSkipped: boolean
    local: number
    issues: IntervalSyncIssue[]
  }
  day: {
    changed: number
    deleted: number
    deleteSkipped: boolean
    local: number
  }
}

export async function syncEvidence(
  options: {
    dryRun?: boolean
    baseUrl?: string
    token?: string | null
    fetch?: SyncFetch
    registeredProjects?: readonly RegisteredTaskSpace[]
  } = {},
): Promise<SyncResult> {
  const baseUrl = options.baseUrl ?? process.env.HUB_HOSTED_URL
  if (process.env.NODE_ENV === 'test' && baseUrl && !options.fetch) throw new Error(TEST_REFUSAL)
  const intervalRows = localIntervals()
  const intervalLedger = ledger('interval')
  const invalidIntervalLedger = intervalLedger.filter(
    (row) => !hasRecordIdShape(row.local_key),
  )
  const validIntervalLedger = intervalLedger.filter((row) => hasRecordIdShape(row.local_key))
  const day = diffDays(localDays(), ledger('day'))
  const result: SyncResult = {
    interval: {
      changed: 0,
      deleted: 0,
      deleteSkipped: false,
      local: intervalRows.length,
      issues: [],
    },
    day: {
      changed: day.changed.length,
      deleted: 0,
      deleteSkipped: false,
      local: day.localCount,
    },
  }
  if (!baseUrl) return result
  const token = options.token ?? readRecordSessionToken()
  if (!token) throw new Error('record session is absent; run `orch record sign-in`')
  const fetchImpl = options.fetch ?? fetch
  const requestOptions = { baseUrl, token, fetch: fetchImpl }
  const identity = await hostedTaskIdentity(requestOptions)
  assertTargetSpaceIntervalEvidence(identity)
  assertIntervalRecordId(identity)
  if (day.changed.length > 0) assertDayRecordId(identity)
  const interval = intervalDeliveries(
    intervalRows,
    validIntervalLedger,
    options.registeredProjects ?? projects(),
    identity,
  )
  const currentKeys = new Set(intervalRows.map((row) => row.key))
  const deleteSkipped = intervalRows.length === 0 && validIntervalLedger.length > 0
  const vanished = deleteSkipped
    ? []
    : validIntervalLedger.filter((row) => !currentKeys.has(row.local_key))
  const vanishedWithDestination = vanished.filter(
    (row): row is LedgerRow & { destination_space_id: string } => row.destination_space_id !== null,
  )
  const vanishedWithoutDestination = vanished.filter((row) => row.destination_space_id === null)
  result.interval.changed = interval.deliveries.length
  result.interval.deleted = vanishedWithDestination.length
  result.interval.deleteSkipped = deleteSkipped
  result.interval.issues.push(...interval.refused)
  for (const row of invalidIntervalLedger)
    result.interval.issues.push({
      project: null,
      reason: `interval ledger row '${row.local_key}' is not keyed by UUID; it was left in place`,
    })
  if (vanishedWithoutDestination.length > 0)
    result.interval.issues.push({
      project: null,
      reason: `${vanishedWithoutDestination.length} vanished interval acknowledgement${
        vanishedWithoutDestination.length === 1 ? '' : 's'
      } had an unknown hosted destination; the hosted row${
        vanishedWithoutDestination.length === 1 ? ' was' : 's were'
      } left in place`,
    })
  if (options.dryRun) return result

  const deliveryRequest = { fetch: fetchImpl, baseUrl, token }
  forgetIntervals(vanishedWithoutDestination.map((row) => row.local_key))
  result.interval.issues.push(
    ...(await deleteVanishedIntervals(vanishedWithDestination, deliveryRequest)),
    ...(await deliverIntervalChanges(interval.deliveries, deliveryRequest)),
  )
  for (const group of batches(day.changed.map((entry) => entry.row)))
    await request(fetchImpl, baseUrl, token, '/v1/evidence/days', 'PUT', {
      rows: group,
    })
  commitLedger('day', day)
  return result
}

export function printSyncResult(result: SyncResult) {
  for (const table of ['interval', 'day'] as const) {
    const row = result[table]
    console.log(
      `${table.padEnd(9)} ${row.changed} changed, ${row.deleted} deleted, ${row.local} local`,
    )
    if (row.deleteSkipped) console.log(`${table.padEnd(9)} deletes skipped: local table is empty`)
  }
  for (const issue of result.interval.issues)
    console.log(`interval  ${issue.project ?? '(no project)'}: ${issue.reason}`)
}
