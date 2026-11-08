// concern: record-retention
/** Runs hosted retention under one cross-instance lock without coupling the job to the API lifecycle. */

import type { SQL } from 'bun'
import { BOARD_PRESENCE_RETENTION_MS } from './record-board-presence.ts'
import { recordPool } from './record-pool.ts'

export const RECORD_RETENTION_INTERVAL_MS = 60 * 60_000
export const RECORD_RETENTION_START_DELAY_MS = 10_000
// Serializes every prune across record API instances.
export const RECORD_RETENTION_ADVISORY_LOCK_KEY = 2_121_000_001

type IntervalTimer = ReturnType<typeof setInterval>
type TimeoutTimer = ReturnType<typeof setTimeout>
type PruneOutcome = { deleted: number } | { failure: string }
type PruneOutcomes = {
  recordChange: PruneOutcome
  contention: PruneOutcome
  boardPresence: PruneOutcome
}

export type RecordRetentionResult =
  | { acquired: false }
  | { acquired: true; outcomes: PruneOutcomes }

export type RecordRetentionAdapters = {
  prune(): Promise<RecordRetentionResult>
  setInterval(callback: () => void, milliseconds: number): IntervalTimer
  clearInterval(timer: IntervalTimer): void
  setTimeout(callback: () => void, milliseconds: number): TimeoutTimer
  clearTimeout(timer: TimeoutTimer): void
  now(): number
  log(line: string): void
}

const rows = <T>(value: unknown) => value as T[]

async function pruneOutcome(prune: () => Promise<number>): Promise<PruneOutcome> {
  try {
    return { deleted: await prune() }
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) }
  }
}

export async function runLockedRecordRetention(input: {
  tryLock(): Promise<boolean>
  pruneRecordChanges(): Promise<number>
  pruneContention(): Promise<number>
  pruneBoardPresence(): Promise<number>
}): Promise<RecordRetentionResult> {
  if (!(await input.tryLock())) return { acquired: false }
  const recordChange = await pruneOutcome(input.pruneRecordChanges)
  const contention = await pruneOutcome(input.pruneContention)
  const boardPresence = await pruneOutcome(input.pruneBoardPresence)
  return {
    acquired: true,
    outcomes: { recordChange, contention, boardPresence },
  }
}

async function pruneFunction(connection: SQL, name: 'record_change_prune' | 'contention_prune') {
  return connection.begin(async (tx) => {
    const result = rows<{ deleted: number | bigint | string }>(
      await tx.unsafe(`SELECT ${name}() AS deleted`),
    )[0]
    if (!result) {
      throw new Error(
        `${name}() returned no result; verify the record retention migrations are applied`,
      )
    }
    return Number(result.deleted)
  })
}

export async function pruneRecordRetention(
  recordUrl: string,
  postgres: SQL = recordPool(recordUrl),
): Promise<RecordRetentionResult> {
  const connection = await postgres.reserve()
  let acquired = false
  try {
    const lock = rows<{ acquired: boolean }>(
      await connection`SELECT pg_try_advisory_lock(${RECORD_RETENTION_ADVISORY_LOCK_KEY}) AS acquired`,
    )[0]
    acquired = lock?.acquired === true
    return await runLockedRecordRetention({
      tryLock: async () => acquired,
      pruneRecordChanges: () => pruneFunction(connection, 'record_change_prune'),
      pruneContention: () => pruneFunction(connection, 'contention_prune'),
      pruneBoardPresence: async () => {
        const result = rows<{ deleted: number | bigint | string }>(
          await connection`SELECT public.board_presence_prune() AS deleted`,
        )[0]
        if (!result) {
          throw new Error(
            `board_presence_prune() returned no result for the ${BOARD_PRESENCE_RETENTION_MS}ms retention window; verify the record retention migrations are applied`,
          )
        }
        return Number(result.deleted)
      },
    })
  } finally {
    try {
      if (acquired) {
        await connection`SELECT pg_advisory_unlock(${RECORD_RETENTION_ADVISORY_LOCK_KEY})`
      }
    } finally {
      connection.release()
    }
  }
}

export async function runRecordRetentionPass(
  adapters: Pick<RecordRetentionAdapters, 'prune' | 'now' | 'log'>,
): Promise<void> {
  const startedAt = adapters.now()
  try {
    const result = await adapters.prune()
    const durationMs = adapters.now() - startedAt
    if (!result.acquired) {
      adapters.log(`record retention skipped: another instance holds the lock (${durationMs}ms)`)
      return
    }
    const format = (name: string, outcome: PruneOutcome) =>
      'deleted' in outcome
        ? `${name} ${outcome.deleted} deleted`
        : `${name} failed (${outcome.failure})`
    adapters.log(
      `record retention: ${format('record_change', result.outcomes.recordChange)}, ${format(
        'contention',
        result.outcomes.contention,
      )}, ${format('board_presence', result.outcomes.boardPresence)} in ${durationMs}ms`,
    )
  } catch (error) {
    const durationMs = adapters.now() - startedAt
    const message = error instanceof Error ? error.message : String(error)
    adapters.log(
      `record retention failed after ${durationMs}ms: ${message}; verify record database connectivity and that record_change_prune() and contention_prune() are installed; the next interval will retry`,
    )
  }
}

export function startRecordRetention(
  overrides: Partial<RecordRetentionAdapters> & Pick<RecordRetentionAdapters, 'prune'>,
): { stop(): void } {
  const adapters: RecordRetentionAdapters = {
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    now: Date.now,
    log: console.log,
    ...overrides,
  }
  const pass = () => void runRecordRetentionPass(adapters)
  let interval: IntervalTimer | undefined
  let timeout: TimeoutTimer | undefined = adapters.setTimeout(() => {
    timeout = undefined
    pass()
    interval = adapters.setInterval(pass, RECORD_RETENTION_INTERVAL_MS)
  }, RECORD_RETENTION_START_DELAY_MS)
  return {
    stop: () => {
      if (timeout !== undefined) adapters.clearTimeout(timeout)
      if (interval !== undefined) adapters.clearInterval(interval)
    },
  }
}
