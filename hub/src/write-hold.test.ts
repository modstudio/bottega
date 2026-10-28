import { expect, test } from 'bun:test'
import {
  type FinishedWriteTransaction,
  finishWriteTransaction,
  type WriteHoldWindow,
  writeTransactionNeedsCaller,
} from './write-hold.ts'

const transaction = (
  beganMs: number,
  endedMs: number,
  caller: string | null,
): FinishedWriteTransaction => ({ beganMs, endedMs, caller })

function finish(
  state: WriteHoldWindow | null,
  value: FinishedWriteTransaction,
): ReturnType<typeof finishWriteTransaction> {
  return finishWriteTransaction(state, value)
}

test('an isolated long transaction emits with its caller when its window closes', () => {
  const first = finish(null, transaction(1_000, 2_100, 'hub/src/outbox.ts:452'))
  const closed = finish(first.state, transaction(3_000, 3_010, null))
  expect(closed.entry).toEqual({
    at: '1970-01-01T00:00:02.100Z',
    store: 'hub.db',
    spanMs: 1_100,
    longestMs: 1_100,
    transactions: 1,
    caller: 'hub/src/outbox.ts:452',
  })
})

test('short back-to-back transactions emit one burst with the longest caller', () => {
  let state: WriteHoldWindow | null = null
  for (const value of [
    transaction(10_000, 10_040, null),
    transaction(10_044, 10_100, 'hub/src/ingest/runs.ts:380'),
    transaction(10_104, 11_020, 'hub/src/outbox.ts:452'),
  ]) {
    state = finish(state, value).state
  }
  const closed = finish(state, transaction(12_000, 12_010, null))
  expect(closed.entry).toMatchObject({
    spanMs: 1_020,
    longestMs: 916,
    transactions: 3,
    caller: 'hub/src/outbox.ts:452',
  })
})

test('a gap beyond the burst gap splits windows', () => {
  const first = finish(null, transaction(0, 600, 'first.ts:1'))
  const second = finish(first.state, transaction(606, 1_206, 'second.ts:2'))
  expect(second.entry).toBeNull()
  expect(second.state).toMatchObject({ beganMs: 606, transactions: 1, caller: 'second.ts:2' })
})

test('a sub-threshold window emits nothing', () => {
  const first = finish(null, transaction(0, 400, 'short.ts:1'))
  expect(finish(first.state, transaction(1_000, 1_010, null)).entry).toBeNull()
})

test('caller capture is limited to qualifying longest transactions in the active window', () => {
  const current = finish(null, transaction(0, 100, 'first.ts:1')).state
  expect(writeTransactionNeedsCaller(current, 104, 90)).toBeFalse()
  expect(writeTransactionNeedsCaller(current, 104, 101)).toBeTrue()
  expect(writeTransactionNeedsCaller(current, 106, 50)).toBeTrue()
  expect(writeTransactionNeedsCaller(current, 106, 49)).toBeFalse()
})
