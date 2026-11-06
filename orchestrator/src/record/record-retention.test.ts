import { expect, test } from 'bun:test'
import {
  RECORD_RETENTION_INTERVAL_MS,
  RECORD_RETENTION_START_DELAY_MS,
  runLockedRecordRetention,
  runRecordRetentionPass,
  startRecordRetention,
} from './record-retention.ts'

// The transaction boundary and advisory-lock SQL are exercised by postgres-record-retention-proof.ts.

test('record retention reports both prune outcomes under an acquired lock', async () => {
  expect(
    await runLockedRecordRetention({
      tryLock: async () => true,
      pruneRecordChanges: async () => 2,
      pruneContention: async () => 3,
    }),
  ).toEqual({
    acquired: true,
    outcomes: { recordChange: { deleted: 2 }, contention: { deleted: 3 } },
  })
})

test('record retention pass reports both deleted counts and one duration', async () => {
  const lines: string[] = []
  const times = [1_000, 1_027]

  await runRecordRetentionPass({
    prune: async () => ({
      acquired: true,
      outcomes: { recordChange: { deleted: 12 }, contention: { deleted: 7 } },
    }),
    now: () => times.shift()!,
    log: (line) => lines.push(line),
  })

  expect(lines).toEqual([
    'record retention: record_change 12 deleted, contention 7 deleted in 27ms',
  ])
})

test('record retention still prunes contention when record change pruning fails', async () => {
  const calls: string[] = []
  const lines: string[] = []

  await runRecordRetentionPass({
    prune: () =>
      runLockedRecordRetention({
        tryLock: async () => true,
        pruneRecordChanges: async () => {
          calls.push('record_change')
          throw new Error('record change unavailable')
        },
        pruneContention: async () => {
          calls.push('contention')
          return 7
        },
      }),
    now: () => 1_000,
    log: (line) => lines.push(line),
  })

  expect(calls).toEqual(['record_change', 'contention'])
  expect(lines).toEqual([
    'record retention: record_change failed (record change unavailable), contention 7 deleted in 0ms',
  ])
})

test('record change prune pass skips without pruning when the transaction lock is unavailable', async () => {
  const lines: string[] = []
  let pruneCalls = 0

  await runRecordRetentionPass({
    prune: () =>
      runLockedRecordRetention({
        tryLock: async () => false,
        pruneRecordChanges: async () => {
          pruneCalls += 1
          return 4
        },
        pruneContention: async () => {
          pruneCalls += 1
          return 5
        },
      }),
    now: () => 1_000,
    log: (line) => lines.push(line),
  })

  expect(pruneCalls).toBe(0)
  expect(lines).toEqual(['record retention skipped: another instance holds the lock (0ms)'])
})

test('a failing record change prune pass is logged and the interval keeps running', async () => {
  const intervalCallbacks: Array<() => void> = []
  const intervalMilliseconds: number[] = []
  const timeoutCallbacks: Array<() => void> = []
  const timeoutMilliseconds: number[] = []
  const lines: string[] = []
  let pruneCalls = 0
  const job = startRecordRetention({
    prune: async () => {
      pruneCalls += 1
      throw new Error('database unavailable')
    },
    setInterval: (callback, delay) => {
      intervalCallbacks.push(callback)
      intervalMilliseconds.push(delay)
      return intervalCallbacks.length as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: () => {},
    setTimeout: (callback, delay) => {
      timeoutCallbacks.push(callback)
      timeoutMilliseconds.push(delay)
      return timeoutCallbacks.length as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: () => {},
    now: () => 1_000,
    log: (line) => lines.push(line),
  })

  expect(timeoutMilliseconds).toEqual([RECORD_RETENTION_START_DELAY_MS])
  expect(intervalMilliseconds).toEqual([])
  timeoutCallbacks[0]!()
  await Promise.resolve()
  await Promise.resolve()
  expect(intervalMilliseconds).toEqual([RECORD_RETENTION_INTERVAL_MS])
  expect(pruneCalls).toBe(1)
  expect(lines).toEqual([
    'record retention failed after 0ms: database unavailable; verify record database connectivity and that record_change_prune() and contention_prune() are installed; the next interval will retry',
  ])

  intervalCallbacks[0]!()
  await Promise.resolve()
  expect(pruneCalls).toBe(2)
  job.stop()
})

test('stopping record retention clears its start timeout and interval', () => {
  const clearedTimeouts: Array<ReturnType<typeof setTimeout>> = []
  const clearedIntervals: Array<ReturnType<typeof setInterval>> = []
  const timeout = 42 as unknown as ReturnType<typeof setTimeout>
  const interval = 43 as unknown as ReturnType<typeof setInterval>
  const waitingJob = startRecordRetention({
    prune: async () => ({
      acquired: true,
      outcomes: { recordChange: { deleted: 0 }, contention: { deleted: 0 } },
    }),
    setTimeout: () => timeout,
    clearTimeout: (value) => clearedTimeouts.push(value),
  })
  waitingJob.stop()

  let start: (() => void) | undefined
  const runningJob = startRecordRetention({
    prune: async () => ({
      acquired: true,
      outcomes: { recordChange: { deleted: 0 }, contention: { deleted: 0 } },
    }),
    setTimeout: (callback) => {
      start = callback
      return timeout
    },
    clearTimeout: () => {},
    setInterval: () => interval,
    clearInterval: (value) => clearedIntervals.push(value),
    log: () => {},
  })
  start!()
  runningJob.stop()

  expect(clearedTimeouts).toEqual([timeout])
  expect(clearedIntervals).toEqual([interval])
})
