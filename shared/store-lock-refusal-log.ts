/** Best-effort file adapter for store lock refusals that cannot be written to either store. */

import { appendBoundedJsonLine, readBoundedJsonLinesSince } from './bounded-json-lines-log.ts'
import {
  type DatabaseLockRefusalFacts,
  databaseLockHolderCommandSummary,
  formatDatabaseLockRefusal,
} from './database-lock-refusal.ts'
import type { StateEnvironment } from './state-directory.ts'

const STORE_LOCK_REFUSAL_LOG_MAX_BYTES = 1_048_576
const LOG_NAME = 'store-lock-refusals'

export type StoreLockRefusalEntry = {
  at: string
  store: string
  holderCommand: string | null
  holderPid: number | null
  verb: string
}

type AppendOptions = {
  maxBytes?: number
  now?: Date
}

function refusalEntry(
  facts: DatabaseLockRefusalFacts,
  argv: readonly string[],
  now: Date,
): StoreLockRefusalEntry {
  return {
    at: now.toISOString(),
    store: facts.store,
    holderCommand:
      'pid' in facts.holder && facts.holder.command
        ? databaseLockHolderCommandSummary(facts.holder.command)
        : null,
    holderPid: 'pid' in facts.holder ? facts.holder.pid : null,
    verb: argv.slice(0, 2).join(' '),
  }
}

/** Append one refusal without ever changing the refusal path when logging is unavailable. */
export function appendStoreLockRefusal(
  facts: DatabaseLockRefusalFacts,
  argv: readonly string[],
  options: AppendOptions = {},
): void {
  appendBoundedJsonLine(refusalEntry(facts, argv, options.now ?? new Date()), {
    maxBytes: options.maxBytes ?? STORE_LOCK_REFUSAL_LOG_MAX_BYTES,
    name: LOG_NAME,
  })
}

/** Record one refusal best-effort and return the message presented to the caller. */
export function recordDatabaseLockRefusal(
  facts: DatabaseLockRefusalFacts,
  argv: readonly string[],
): string {
  appendStoreLockRefusal(facts, argv)
  return formatDatabaseLockRefusal(facts)
}

function parsedEntry(value: unknown): StoreLockRefusalEntry | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (
    typeof row.at !== 'string' ||
    !Number.isFinite(Date.parse(row.at)) ||
    typeof row.store !== 'string' ||
    (row.holderCommand !== null && typeof row.holderCommand !== 'string') ||
    (row.holderPid !== null && (!Number.isInteger(row.holderPid) || Number(row.holderPid) < 1)) ||
    typeof row.verb !== 'string'
  )
    return null
  return row as StoreLockRefusalEntry
}

/** Read valid entries in the window from the current and one previous bounded log. */
export function readStoreLockRefusalsSince(
  since: string,
  env: StateEnvironment = process.env,
): StoreLockRefusalEntry[] {
  return readBoundedJsonLinesSince(since, parsedEntry, {
    env,
    label: 'store lock refusal',
    name: LOG_NAME,
  })
}
