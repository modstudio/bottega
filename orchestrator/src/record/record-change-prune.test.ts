import { expect, test } from 'bun:test'
import {
  RECORD_CHANGE_PRUNE_INTERVAL_MS,
  RECORD_CHANGE_PRUNE_START_DELAY_MS,
  runLockedRecordChangePrune,
  runRecordChangePrunePass,
  startRecordChangePrune,
} from './record-change-prune.ts'

// The transaction boundary and advisory-lock SQL are exercised by postgres-record-change-prune-proof.ts.

test('record change prune pass reports the deleted count and duration', async () => {
  const lines: string[] = []
  const times = [1_000, 1_027]

  await runRecordChangePrunePass({
    prune: async () => ({ acquired: true, deleted: 12 }),
    now: () => times.shift()!,
    log: (line) => lines.push(line),
  })

  expect(lines).toEqual(['record change prune: 12 deleted in 27ms'])
})

test('record change prune pass skips without pruning when the transaction lock is unavailable', async () => {
  const lines: string[] = []
  let pruneCalls = 0

  await runRecordChangePrunePass({
    prune: () =>
      runLockedRecordChangePrune({
        tryLock: async () => false,
        prune: async () => {
          pruneCalls += 1
          return 4
        },
      }),
    now: () => 1_000,
    log: (line) => lines.push(line),
  })

  expect(pruneCalls).toBe(0)
  expect(lines).toEqual(['record change prune skipped: another instance holds the lock (0ms)'])
})

test('a failing record change prune pass is logged and the interval keeps running', async () => {
  const intervalCallbacks: Array<() => void> = []
  const intervalMilliseconds: number[] = []
  const timeoutCallbacks: Array<() => void> = []
  const timeoutMilliseconds: number[] = []
  const lines: string[] = []
  let pruneCalls = 0
  const job = startRecordChangePrune({
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

  expect(timeoutMilliseconds).toEqual([RECORD_CHANGE_PRUNE_START_DELAY_MS])
  expect(intervalMilliseconds).toEqual([])
  timeoutCallbacks[0]!()
  await Promise.resolve()
  await Promise.resolve()
  expect(intervalMilliseconds).toEqual([RECORD_CHANGE_PRUNE_INTERVAL_MS])
  expect(pruneCalls).toBe(1)
  expect(lines).toEqual([
    'record change prune failed after 0ms: database unavailable; verify record database connectivity and that record_change_prune() is installed; the next interval will retry',
  ])

  intervalCallbacks[0]!()
  await Promise.resolve()
  expect(pruneCalls).toBe(2)
  job.stop()
})

test('stopping record change pruning clears its timer', () => {
  const clearedTimeouts: Array<ReturnType<typeof setTimeout>> = []
  const timeout = 42 as unknown as ReturnType<typeof setTimeout>
  const job = startRecordChangePrune({
    prune: async () => ({ acquired: true, deleted: 0 }),
    setTimeout: () => timeout,
    clearTimeout: (value) => clearedTimeouts.push(value),
  })

  job.stop()

  expect(clearedTimeouts).toEqual([timeout])
})

test('stopping record change pruning clears the interval after the first pass', () => {
  const clearedIntervals: Array<ReturnType<typeof setInterval>> = []
  const interval = 43 as unknown as ReturnType<typeof setInterval>
  let start: (() => void) | undefined
  const job = startRecordChangePrune({
    prune: async () => ({ acquired: true, deleted: 0 }),
    setTimeout: (callback) => {
      start = callback
      return 42 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: () => {},
    setInterval: () => interval,
    clearInterval: (value) => clearedIntervals.push(value),
    log: () => {},
  })
  start!()

  job.stop()

  expect(clearedIntervals).toEqual([interval])
})
