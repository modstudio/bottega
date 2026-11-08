/** Best-effort state-root logs for collect-lease contention outcomes and measured holds. */

import { appendBoundedJsonLine, readBoundedJsonLinesSince } from './bounded-json-lines-log.ts'
import type { StateEnvironment } from './state-directory.ts'

const COLLECT_LEASE_LOG_MAX_BYTES = 1_048_576
const REFUSAL_LOG_NAME = 'collect-lease-refusals'
const HOLD_LOG_NAME = 'collect-lease-holds'

export const COLLECT_LEASE_UNREADABLE_CAUSE = 'the lease row could not be read'

export type CollectLeaseContentionEntry = {
  at: string
  waiter: string
  waitedMs: number
  holder: string | null
  holderAgeMs: number | null
  outcome: 'refused' | 'acquired' | 'lost'
  leaseUnreadable: boolean
}

export type CollectLeaseHoldEntry = {
  at: string
  holder: string
  heldMs: number
  legs: string
}

const validTime = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
const validDuration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

function parsedRefusal(value: unknown): CollectLeaseContentionEntry | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (
    !validTime(row.at) ||
    typeof row.waiter !== 'string' ||
    !validDuration(row.waitedMs) ||
    (row.holder !== null && typeof row.holder !== 'string') ||
    (row.holderAgeMs !== null && !validDuration(row.holderAgeMs)) ||
    (row.outcome !== undefined &&
      row.outcome !== 'refused' &&
      row.outcome !== 'acquired' &&
      row.outcome !== 'lost') ||
    (row.leaseUnreadable !== undefined && typeof row.leaseUnreadable !== 'boolean')
  )
    return null
  return {
    ...(row as Omit<CollectLeaseContentionEntry, 'outcome' | 'leaseUnreadable'>),
    outcome: row.outcome === 'acquired' || row.outcome === 'lost' ? row.outcome : 'refused',
    leaseUnreadable: row.leaseUnreadable === true,
  }
}

function parsedHold(value: unknown): CollectLeaseHoldEntry | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (
    !validTime(row.at) ||
    typeof row.holder !== 'string' ||
    !validDuration(row.heldMs) ||
    typeof row.legs !== 'string'
  )
    return null
  return row as CollectLeaseHoldEntry
}

/** Append without allowing measurement failure to affect the contention outcome. */
export function appendCollectLeaseContention(entry: CollectLeaseContentionEntry): void {
  appendBoundedJsonLine(entry, {
    maxBytes: COLLECT_LEASE_LOG_MAX_BYTES,
    name: REFUSAL_LOG_NAME,
  })
}

/** Append without allowing measurement failure to affect the measured collection. */
export function appendCollectLeaseHold(entry: CollectLeaseHoldEntry): void {
  appendBoundedJsonLine(entry, {
    maxBytes: COLLECT_LEASE_LOG_MAX_BYTES,
    name: HOLD_LOG_NAME,
  })
}

export function readCollectLeaseContentionSince(
  since: string,
  env: StateEnvironment = process.env,
): CollectLeaseContentionEntry[] {
  return readBoundedJsonLinesSince(since, parsedRefusal, {
    env,
    label: 'collect lease contention',
    name: REFUSAL_LOG_NAME,
  })
}

export function readCollectLeaseHoldsSince(
  since: string,
  env: StateEnvironment = process.env,
): CollectLeaseHoldEntry[] {
  return readBoundedJsonLinesSince(since, parsedHold, {
    env,
    label: 'collect lease hold',
    name: HOLD_LOG_NAME,
  })
}
