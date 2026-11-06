// concern: record-change-prune
/** Runs hosted record-change retention without coupling the job to the API server lifecycle. */

import type { SQL } from 'bun'
import { recordPool } from './record-pool.ts'

export const RECORD_CHANGE_PRUNE_INTERVAL_MS = 60 * 60_000
export const RECORD_CHANGE_PRUNE_START_DELAY_MS = 10_000

// Serializes record_change pruning across every running record API instance.
export const RECORD_CHANGE_PRUNE_ADVISORY_LOCK_KEY = 2_121_000_001

type IntervalTimer = ReturnType<typeof setInterval>
type TimeoutTimer = ReturnType<typeof setTimeout>

export type RecordChangePruneResult = { acquired: false } | { acquired: true; deleted: number }

export type RecordChangePruneAdapters = {
  prune(): Promise<RecordChangePruneResult>
  setInterval(callback: () => void, milliseconds: number): IntervalTimer
  clearInterval(timer: IntervalTimer): void
  setTimeout(callback: () => void, milliseconds: number): TimeoutTimer
  clearTimeout(timer: TimeoutTimer): void
  now(): number
  log(line: string): void
}

const rows = <T>(value: unknown) => value as T[]

export async function runLockedRecordChangePrune(input: {
  tryLock(): Promise<boolean>
  prune(): Promise<number>
}): Promise<RecordChangePruneResult> {
  if (!(await input.tryLock())) return { acquired: false }
  return { acquired: true, deleted: await input.prune() }
}

export async function pruneRecordChanges(
  recordUrl: string,
  postgres: SQL = recordPool(recordUrl),
): Promise<RecordChangePruneResult> {
  return postgres.begin((tx) =>
    runLockedRecordChangePrune({
      tryLock: async () => {
        const lock = rows<{ acquired: boolean }>(
          await tx`SELECT pg_try_advisory_xact_lock(${RECORD_CHANGE_PRUNE_ADVISORY_LOCK_KEY}) AS acquired`,
        )[0]
        return lock?.acquired === true
      },
      prune: async () => {
        const result = rows<{ deleted: number | bigint | string }>(
          await tx`SELECT record_change_prune() AS deleted`,
        )[0]
        if (!result) {
          throw new Error(
            'record_change_prune() returned no result; verify the record change migration is applied',
          )
        }
        return Number(result.deleted)
      },
    }),
  )
}

export async function runRecordChangePrunePass(
  adapters: Pick<RecordChangePruneAdapters, 'prune' | 'now' | 'log'>,
): Promise<void> {
  const startedAt = adapters.now()
  try {
    const result = await adapters.prune()
    const durationMs = adapters.now() - startedAt
    if (!result.acquired) {
      adapters.log(`record change prune skipped: another instance holds the lock (${durationMs}ms)`)
      return
    }
    adapters.log(`record change prune: ${result.deleted} deleted in ${durationMs}ms`)
  } catch (error) {
    const durationMs = adapters.now() - startedAt
    const message = error instanceof Error ? error.message : String(error)
    adapters.log(
      `record change prune failed after ${durationMs}ms: ${message}; verify record database connectivity and that record_change_prune() is installed; the next interval will retry`,
    )
  }
}

export function startRecordChangePrune(
  overrides: Partial<RecordChangePruneAdapters> & Pick<RecordChangePruneAdapters, 'prune'>,
): { stop(): void } {
  const adapters: RecordChangePruneAdapters = {
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    now: Date.now,
    log: console.log,
    ...overrides,
  }
  const pass = () => void runRecordChangePrunePass(adapters)
  let interval: IntervalTimer | undefined
  let timeout: TimeoutTimer | undefined = adapters.setTimeout(() => {
    timeout = undefined
    pass()
    interval = adapters.setInterval(pass, RECORD_CHANGE_PRUNE_INTERVAL_MS)
  }, RECORD_CHANGE_PRUNE_START_DELAY_MS)
  return {
    stop: () => {
      if (timeout !== undefined) adapters.clearTimeout(timeout)
      if (interval !== undefined) adapters.clearInterval(interval)
    },
  }
}
