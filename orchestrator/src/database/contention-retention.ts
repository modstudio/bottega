// concern: contention retention
/** Rolls complete contention days into exact aggregates and releases safely synced raw rows. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { DEFAULT_EFFICIENCY_WINDOW_MS } from '../host-pressure/host-pressure-decision.ts'
import { enqueueClosedSlowStatementContentions } from '../record/landing-outbox.ts'
import { deleteDeliveredUnprotectedOutboxRows } from '../record/outbox-prune.ts'
import {
  contentionRolledThroughDay,
  setContentionRolledThroughDay,
} from './contention-rollup-state.ts'
import { writeTransaction } from './db.ts'
import { drainRetentionChunks } from './retention-chunks.ts'
import { SLOW_STATEMENT_BUCKET_PREDICATE, slowStatementBucketStart } from './slow-statements.ts'

export const CONTENTION_RAW_WINDOW_MS = 2 * DEFAULT_EFFICIENCY_WINDOW_MS
const CONTENTION_RETENTION_CHUNK_SIZE = 5_000
const CONTENTION_PRUNE_PREDICATE = `c.at < ?1 AND c.at < date(?2, '+1 day')
  AND (NOT (${SLOW_STATEMENT_BUCKET_PREDICATE}) OR EXISTS (
    SELECT 1 FROM outbox sent WHERE sent.kind='contention' AND sent.row_id=c.record_id
  ))
  AND NOT EXISTS (
    SELECT 1 FROM outbox o WHERE o.kind='contention' AND o.row_id=c.record_id
      AND (o.synced_at IS NULL OR o.quarantined_at IS NOT NULL)
  )`
export type ContentionRollupResult = { days: number; more: boolean }
export type ContentionPruneResult = { rows: number; more: boolean }

const utcDay = (instant: number): string => new Date(instant).toISOString().slice(0, 10)

function nextRollupDay(database: Database, today: string): string | null {
  const watermark = contentionRolledThroughDay(database)
  if (watermark)
    return (
      database
        .query<{ day: string }, [string, string, string]>(
          "SELECT date(?, '+1 day') day WHERE date(?, '+1 day') < date(?)",
        )
        .get(watermark, watermark, today)?.day ?? null
    )
  return (
    database
      .query<{ day: string }, [string]>(
        'SELECT substr(MIN(at),1,10) day FROM contention WHERE at < ?',
      )
      .get(today)?.day ?? null
  )
}

function rollupDay(database: Database, day: string): void {
  const rows = database
    .query<
      {
        session_id: string | null
        resource_kind: string
        resource_key: string
        event_kind: string
        event_count: number
        total_duration_ms: number
      },
      [string, string]
    >(
      `SELECT session_id,resource_kind,resource_key,event_kind,SUM(occurrences) event_count,
              SUM(MAX(0,COALESCE(duration_ms,0))) total_duration_ms
       FROM contention WHERE at>=? AND at<date(?, '+1 day')
       GROUP BY session_id,resource_kind,resource_key,event_kind`,
    )
    .all(day, day)
  const upsert = database.query(
    `INSERT INTO contention_day
       (record_id,day,session_id,resource_kind,resource_key,event_kind,event_count,total_duration_ms)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT DO UPDATE SET
       event_count=excluded.event_count,total_duration_ms=excluded.total_duration_ms`,
  )
  for (const row of rows)
    upsert.run(
      newRecordId(),
      day,
      row.session_id,
      row.resource_kind,
      row.resource_key,
      row.event_kind,
      row.event_count,
      row.total_duration_ms,
    )
  setContentionRolledThroughDay(database, day)
}

export function rollupContentionDays(
  database: Database,
  options: { now?: number; timeBoundMs?: number; dryRun?: boolean } = {},
): ContentionRollupResult {
  const now = options.now ?? Date.now()
  const today = utcDay(now)
  if (options.dryRun) {
    const first = nextRollupDay(database, today)
    if (!first) return { days: 0, more: false }
    const days = database
      .query<{ count: number }, [string, string]>(
        'SELECT CAST(julianday(?) - julianday(?) AS INTEGER) count',
      )
      .get(today, first)!.count
    return { days, more: days > 0 }
  }
  writeTransaction(
    () => enqueueClosedSlowStatementContentions(database, '', slowStatementBucketStart(now)),
    database,
  )
  const started = performance.now()
  let days = 0
  let next = nextRollupDay(database, today)
  while (
    next &&
    (days === 0 ||
      options.timeBoundMs === undefined ||
      performance.now() - started < options.timeBoundMs)
  ) {
    const day = next
    writeTransaction(() => rollupDay(database, day), database)
    days += 1
    next = nextRollupDay(database, today)
  }
  return { days, more: next !== null }
}

function dryRunWatermark(database: Database, today: string): string | null {
  const watermark = contentionRolledThroughDay(database)
  const hasCompleteRawDay = database
    .query<{ found: number }, [string]>(
      'SELECT EXISTS(SELECT 1 FROM contention WHERE at < ?) found',
    )
    .get(today)!.found
  if (!watermark && !hasCompleteRawDay) return null
  const lastCompleteDay = database
    .query<{ day: string }, [string]>("SELECT date(?, '-1 day') day")
    .get(today)!.day
  return watermark && watermark >= lastCompleteDay ? watermark : lastCompleteDay
}

function eligibleRawCount(database: Database, cutoff: string, watermark: string | null): number {
  return database
    .query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) count FROM contention c WHERE ${CONTENTION_PRUNE_PREDICATE}`,
    )
    .get(cutoff, watermark ?? '')!.count
}

export function contentionRawHorizon(database: Database, now = Date.now()): string | null {
  if (!contentionRolledThroughDay(database)) return null
  return new Date(now - CONTENTION_RAW_WINDOW_MS).toISOString()
}

export function pruneContentionRows(
  database: Database,
  options: { now?: number; limit?: number; timeBoundMs?: number; dryRun?: boolean } = {},
): ContentionPruneResult {
  const now = options.now ?? Date.now()
  const cutoff = new Date(now - CONTENTION_RAW_WINDOW_MS).toISOString()
  if (options.dryRun) {
    const today = utcDay(now)
    const rows = eligibleRawCount(database, cutoff, dryRunWatermark(database, today))
    return { rows, more: rows > 0 }
  }
  const limit = options.limit ?? CONTENTION_RETENTION_CHUNK_SIZE
  const drained = drainRetentionChunks<{ record_id: string }, number>({
    limit,
    timeBoundMs: options.timeBoundMs,
    initial: 0,
    select: (chunkLimit) =>
      database
        .query<{ record_id: string }, [string, string, number]>(
          `SELECT c.record_id FROM contention c
           WHERE ${CONTENTION_PRUNE_PREDICATE}
           ORDER BY c.at,c.record_id LIMIT ?3`,
        )
        .all(cutoff, contentionRolledThroughDay(database) ?? '', chunkLimit),
    remove: (selected) => {
      writeTransaction(() => {
        const remove = database.query('DELETE FROM contention WHERE record_id=?')
        for (const row of selected) {
          deleteDeliveredUnprotectedOutboxRows(database, 'contention', row.record_id)
          remove.run(row.record_id)
        }
      }, database)
    },
    accumulate: (rows, selected) => rows + selected.length,
  })
  return { rows: drained.total, more: drained.more }
}
