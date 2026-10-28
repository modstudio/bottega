/** Best-effort state-root log for measured hub write-lock hold windows. */

import { appendBoundedJsonLine, readBoundedJsonLinesSince } from './bounded-json-lines-log.ts'
import type { StateEnvironment } from './state-directory.ts'

const STORE_WRITE_HOLD_LOG_MAX_BYTES = 1_048_576
const LOG_NAME = 'store-write-holds'

export type StoreWriteHoldEntry = {
  at: string
  store: string
  spanMs: number
  longestMs: number
  transactions: number
  caller: string
}

function parsedEntry(value: unknown): StoreWriteHoldEntry | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (
    typeof row.at !== 'string' ||
    !Number.isFinite(Date.parse(row.at)) ||
    typeof row.store !== 'string' ||
    typeof row.spanMs !== 'number' ||
    !Number.isFinite(row.spanMs) ||
    row.spanMs < 0 ||
    typeof row.longestMs !== 'number' ||
    !Number.isFinite(row.longestMs) ||
    row.longestMs < 0 ||
    !Number.isInteger(row.transactions) ||
    Number(row.transactions) < 1 ||
    typeof row.caller !== 'string'
  )
    return null
  return row as StoreWriteHoldEntry
}

/** Append without allowing measurement failure to affect the measured write. */
export function appendStoreWriteHold(entry: StoreWriteHoldEntry): void {
  appendBoundedJsonLine(entry, {
    maxBytes: STORE_WRITE_HOLD_LOG_MAX_BYTES,
    name: LOG_NAME,
  })
}

export function readStoreWriteHoldsSince(
  since: string,
  env: StateEnvironment = process.env,
): StoreWriteHoldEntry[] {
  return readBoundedJsonLinesSince(since, parsedEntry, {
    env,
    label: 'store write hold',
    name: LOG_NAME,
  })
}
