/** Best-effort file adapter for store lock refusals that cannot be written to either store. */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendBoundedJsonLine, readBoundedJsonLinesSince } from './bounded-json-lines-log.ts'
import {
  type DatabaseLockRefusalFacts,
  databaseLockHolderCommandSummary,
  formatDatabaseLockRefusal,
  sqliteErrorIdentity,
} from './database-lock-refusal.ts'
import type { StateEnvironment } from './state-directory.ts'
import { writeCallerFromStack } from './write-caller-from-stack.ts'

const STORE_LOCK_REFUSAL_LOG_MAX_BYTES = 1_048_576
const LOG_NAME = 'store-lock-refusals'
const refusalLogSourcePath = fileURLToPath(import.meta.url)
// Shared frames are logging plumbing; the first concern frame above them owns the write.
const refusalLogDirectory = dirname(refusalLogSourcePath)

export type StoreLockRefusalEntry = {
  at: string
  caller: string | null
  code: string | null
  errno: number | null
  store: string
  holderCommand: string | null
  holderUnavailable: string | null
  holderPid: number | null
  verb: string
}

type AppendOptions = {
  maxBytes?: number
  now?: Date
}

export type StoreAdapterFrames = {
  files?: readonly string[]
  directories?: readonly string[]
}

function refusalEntry(
  facts: DatabaseLockRefusalFacts,
  argv: readonly string[],
  error: unknown,
  storeAdapterFrames: StoreAdapterFrames,
  now: Date,
): StoreLockRefusalEntry {
  const identity = sqliteErrorIdentity(error)
  const stack =
    error && (typeof error === 'object' || typeof error === 'function')
      ? (error as { stack?: unknown }).stack
      : null
  return {
    at: now.toISOString(),
    caller:
      typeof stack === 'string'
        ? writeCallerFromStack(stack, {
            excludedFiles: storeAdapterFrames.files,
            excludedDirectories: [refusalLogDirectory, ...(storeAdapterFrames.directories ?? [])],
          })
        : null,
    code: identity.code,
    errno: identity.errno,
    store: facts.store,
    holderCommand:
      'pid' in facts.holder && facts.holder.command
        ? databaseLockHolderCommandSummary(facts.holder.command)
        : null,
    holderUnavailable: 'unavailable' in facts.holder ? facts.holder.unavailable : null,
    holderPid: 'pid' in facts.holder ? facts.holder.pid : null,
    verb: argv.slice(0, 2).join(' '),
  }
}

/** Append one refusal without ever changing the refusal path when logging is unavailable. */
export function appendStoreLockRefusal(
  facts: DatabaseLockRefusalFacts,
  argv: readonly string[],
  error: unknown,
  /** The concern's own store-adapter frames, skipped to reach the writing caller. */
  storeAdapterFrames: StoreAdapterFrames,
  options: AppendOptions = {},
): void {
  try {
    appendBoundedJsonLine(
      refusalEntry(facts, argv, error, storeAdapterFrames, options.now ?? new Date()),
      {
        maxBytes: options.maxBytes ?? STORE_LOCK_REFUSAL_LOG_MAX_BYTES,
        name: LOG_NAME,
      },
    )
  } catch {
    // Measurement must never change the refusal's result or message.
  }
}

/** Record one refusal best-effort and return the message presented to the caller. */
export function recordDatabaseLockRefusal(
  facts: DatabaseLockRefusalFacts,
  argv: readonly string[],
  error: unknown,
  /** The concern's own store-adapter frames, skipped to reach the writing caller. */
  storeAdapterFrames: StoreAdapterFrames,
): string {
  appendStoreLockRefusal(facts, argv, error, storeAdapterFrames)
  return formatDatabaseLockRefusal(facts)
}

function parsedEntry(value: unknown): StoreLockRefusalEntry | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (
    typeof row.at !== 'string' ||
    !Number.isFinite(Date.parse(row.at)) ||
    (row.caller !== undefined && row.caller !== null && typeof row.caller !== 'string') ||
    (row.code !== undefined && row.code !== null && typeof row.code !== 'string') ||
    (row.errno !== undefined && row.errno !== null && !Number.isInteger(row.errno)) ||
    typeof row.store !== 'string' ||
    (row.holderCommand !== null && typeof row.holderCommand !== 'string') ||
    (row.holderUnavailable !== undefined &&
      row.holderUnavailable !== null &&
      typeof row.holderUnavailable !== 'string') ||
    (row.holderPid !== null && (!Number.isInteger(row.holderPid) || Number(row.holderPid) < 1)) ||
    typeof row.verb !== 'string'
  )
    return null
  return {
    at: row.at,
    caller: typeof row.caller === 'string' ? row.caller : null,
    code: typeof row.code === 'string' ? row.code : null,
    errno: typeof row.errno === 'number' ? row.errno : null,
    store: row.store,
    holderCommand: typeof row.holderCommand === 'string' ? row.holderCommand : null,
    holderUnavailable: typeof row.holderUnavailable === 'string' ? row.holderUnavailable : null,
    holderPid: typeof row.holderPid === 'number' ? row.holderPid : null,
    verb: row.verb,
  }
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
