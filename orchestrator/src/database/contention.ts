import type { Database } from 'bun:sqlite'
import { basename } from 'node:path'
import { newRecordId } from '../../../shared/record/schema.ts'
import type { StoreLockRefusalEntry } from '../../../shared/store-lock-refusal-log.ts'
import type { StoreWriteHoldEntry } from '../../../shared/store-write-hold-log.ts'
import type { RecordedHostLoad } from '../gate-load.ts'
import { enqueueContention } from '../record/landing-outbox.ts'

const RESOURCE_KINDS = [
  'trunk',
  'main_checkout',
  'store',
  'cpu',
  'vendor',
  'review',
  'register',
  'lock',
] as const
export const STORE_LOCK_REFUSAL_KIND = 'store-lock-refusal'
export const STORE_WRITE_HOLD_KIND = 'store-write-hold'
const EVENT_KINDS = ['wait', 'refusal', 'invalidation', 'retry', 'timeout'] as const

type ResourceKind = (typeof RESOURCE_KINDS)[number]
type EventKind = (typeof EVENT_KINDS)[number]

export type ContentionWrite = {
  at?: string
  sessionId?: string | null
  resourceKind: ResourceKind
  resourceKey: string
  eventKind: EventKind
  durationMs?: number | null
  cause?: string | null
  runId?: string | null
  landingId?: string | null
  hostLoad?: RecordedHostLoad | null
}

type ContentionResourceSummary = {
  kind: ResourceKind | typeof STORE_LOCK_REFUSAL_KIND | typeof STORE_WRITE_HOLD_KIND
  count: number
  totalDurationMs: number
  meanDurationMs: number
  topKeys: { key: string; count: number }[]
}

type ContentionSessionSummary = {
  sessionId: string
  waitsSuffered: number
  invalidationsCaused: number
}

export type ContentionSummary = {
  resources: ContentionResourceSummary[]
  sessions: ContentionSessionSummary[]
}

type ContentionRow = {
  session_id: string | null
  resource_kind: ResourceKind
  resource_key: string
  event_kind: EventKind
  duration_ms: number | null
  landing_record_id: string | null
  cause: string | null
  at: string
}

export type ContentionWait = {
  at: string
  resourceKind: ResourceKind
  resourceKey: string
  durationMs: number | null
}

const emptyContention = (): ContentionSummary => ({
  resources: RESOURCE_KINDS.map((kind) => ({
    kind,
    count: 0,
    totalDurationMs: 0,
    meanDurationMs: 0,
    topKeys: [],
  })),
  sessions: [],
})

function topKeys<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): { key: string; count: number }[] {
  const keys = new Map<string, number>()
  for (const row of rows) {
    const key = keyOf(row)
    keys.set(key, (keys.get(key) ?? 0) + 1)
  }
  return [...keys]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 3)
}

const storeLabel = (store: string): string => basename(store)

export function summarizeStoreLockRefusals(
  entries: readonly StoreLockRefusalEntry[],
): ContentionResourceSummary {
  return {
    kind: STORE_LOCK_REFUSAL_KIND,
    count: entries.length,
    totalDurationMs: 0,
    meanDurationMs: 0,
    topKeys: topKeys(
      entries,
      (entry) => `${storeLabel(entry.store)} held by ${entry.holderCommand ?? 'unknown'}`,
    ),
  }
}

export function summarizeStoreWriteHolds(
  entries: readonly StoreWriteHoldEntry[],
): ContentionResourceSummary {
  const totalDurationMs = entries.reduce((sum, entry) => sum + entry.spanMs, 0)
  return {
    kind: STORE_WRITE_HOLD_KIND,
    count: entries.length,
    totalDurationMs,
    meanDurationMs: entries.length ? Math.round(totalDurationMs / entries.length) : 0,
    topKeys: topKeys(entries, (entry) => `${storeLabel(entry.store)} ${entry.caller}`),
  }
}

export function contentionTableExists(d: Database): boolean {
  return !!d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contention'").get()
}

export function insertContention(d: Database, row: ContentionWrite): void {
  const at = row.at ?? new Date().toISOString()
  const inserted = d
    .query(
      `INSERT INTO contention
         (record_id, at, session_id, resource_kind, resource_key, event_kind, duration_ms, cause, run_record_id, landing_record_id, host_load)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING record_id`,
    )
    .get(
      newRecordId(),
      at,
      row.sessionId === undefined ? (process.env.CLAUDE_CODE_SESSION_ID ?? null) : row.sessionId,
      row.resourceKind,
      row.resourceKey,
      row.eventKind,
      row.durationMs == null ? null : Math.round(row.durationMs),
      row.cause ?? null,
      row.runId ?? null,
      row.landingId ?? null,
      row.hostLoad == null ? null : JSON.stringify(row.hostLoad),
    ) as { record_id: string }
  enqueueContention(d, inserted.record_id, at)
}

export function summarizeContention(d: Database, from: string): ContentionSummary {
  if (!contentionTableExists(d)) return emptyContention()
  const rows = d
    .query(
      `SELECT session_id, resource_kind, resource_key, event_kind, duration_ms
       FROM contention WHERE datetime(at) >= datetime(?)`,
    )
    .all(from) as Omit<ContentionRow, 'landing_record_id' | 'cause' | 'at'>[]
  const resources = RESOURCE_KINDS.map((kind): ContentionResourceSummary => {
    const matching = rows.filter((row) => row.resource_kind === kind)
    const totalDurationMs = matching.reduce(
      (sum, row) => sum + Math.max(0, row.duration_ms ?? 0),
      0,
    )
    return {
      kind,
      count: matching.length,
      totalDurationMs,
      meanDurationMs: matching.length ? Math.round(totalDurationMs / matching.length) : 0,
      topKeys: topKeys(matching, (row) => row.resource_key),
    }
  })
  const sessions = new Map<string, ContentionSessionSummary>()
  const session = (id: string) => {
    const found = sessions.get(id)
    if (found) return found
    const created = { sessionId: id, waitsSuffered: 0, invalidationsCaused: 0 }
    sessions.set(id, created)
    return created
  }
  for (const row of rows) {
    if (!row.session_id) continue
    if (row.event_kind === 'wait') session(row.session_id).waitsSuffered += 1
    if (row.event_kind === 'invalidation') session(row.session_id).invalidationsCaused += 1
  }
  return {
    resources,
    sessions: [...sessions.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
  }
}

export function loadContentionWaits(d: Database, from: string, until: string): ContentionWait[] {
  if (!contentionTableExists(d)) return []
  const rows = d
    .query(
      `SELECT at,resource_kind,resource_key,duration_ms FROM contention
       WHERE event_kind='wait' AND datetime(at)>=datetime(?) AND datetime(at)<datetime(?)
       ORDER BY at,record_id`,
    )
    .all(from, until) as Pick<
    ContentionRow,
    'at' | 'resource_kind' | 'resource_key' | 'duration_ms'
  >[]
  return rows.map((row) => ({
    at: row.at,
    resourceKind: row.resource_kind,
    resourceKey: row.resource_key,
    durationMs: row.duration_ms,
  }))
}
