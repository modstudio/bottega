/** Best-effort file adapter for store lock refusals that cannot be written to either store. */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type DatabaseLockRefusalFacts,
  databaseLockHolderCommandSummary,
  formatDatabaseLockRefusal,
} from './database-lock-refusal.ts'
import { resolveStateRoot, type StateEnvironment } from './state-directory.ts'

const STORE_LOCK_REFUSAL_LOG_MAX_BYTES = 1_048_576
const LOG_NAME = 'store-lock-refusals.jsonl'
const PREVIOUS_LOG_NAME = 'store-lock-refusals.previous.jsonl'

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

function logPaths(env: StateEnvironment): { current: string; previous: string } {
  const root = resolveStateRoot(env)
  return {
    current: join(root, LOG_NAME),
    previous: join(root, PREVIOUS_LOG_NAME),
  }
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
  try {
    const paths = logPaths(process.env)
    const line = `${JSON.stringify(refusalEntry(facts, argv, options.now ?? new Date()))}\n`
    mkdirSync(dirname(paths.current), { recursive: true })
    const maxBytes = options.maxBytes ?? STORE_LOCK_REFUSAL_LOG_MAX_BYTES
    let currentBytes = 0
    try {
      currentBytes = statSync(paths.current).size
    } catch {
      // An absent current file starts at zero; append below reports every other failure.
    }
    if (currentBytes > 0 && currentBytes + Buffer.byteLength(line) > maxBytes) {
      renameSync(paths.current, paths.previous)
    }
    appendFileSync(paths.current, line, 'utf8')
  } catch {
    // Measurement is best-effort and must never replace the original store refusal.
  }
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

function readLog(path: string): StoreLockRefusalEntry[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = parsedEntry(JSON.parse(line))
          return entry ? [entry] : []
        } catch {
          return []
        }
      })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(
      `store lock refusal log could not be read: ${path}: ${cause}\n` +
        `cleared by: make ${path} readable or remove it so a new log can be created`,
      { cause: error },
    )
  }
}

/** Read valid entries in the window from the current and one previous bounded log. */
export function readStoreLockRefusalsSince(
  since: string,
  env: StateEnvironment = process.env,
): StoreLockRefusalEntry[] {
  const paths = logPaths(env)
  const sinceMs = Date.parse(since)
  if (!Number.isFinite(sinceMs)) return []
  return [...readLog(paths.previous), ...readLog(paths.current)]
    .filter((entry) => Date.parse(entry.at) >= sinceMs)
    .sort((left, right) => left.at.localeCompare(right.at))
}
