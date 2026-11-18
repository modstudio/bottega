import { expect, test } from 'bun:test'
import {
  exceedsLongLivedRecordRequestRate,
  LONG_LIVED_RECORD_REQUEST_ALLOWANCE,
  LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX,
} from './run-record-request-rate.ts'

test('short-lived startup requests stay within the long-lived request allowance', () => {
  expect(exceedsLongLivedRecordRequestRate({ count: 30, windowIndex: 1 })).toBe(false)
  expect(
    exceedsLongLivedRecordRequestRate({
      count: LONG_LIVED_RECORD_REQUEST_ALLOWANCE,
      windowIndex: 1,
    }),
  ).toBe(false)
})

test('later full windows warn above the bound', () => {
  expect(
    exceedsLongLivedRecordRequestRate({
      count: LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX,
      windowIndex: 2,
    }),
  ).toBe(false)
  expect(
    exceedsLongLivedRecordRequestRate({
      count: LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX + 1,
      windowIndex: 2,
    }),
  ).toBe(true)
})

test('window policy catches bursts hidden by a whole-run average', () => {
  const counts = Array.from({ length: 60 }, (_, index) => (index < 10 ? 20 : 0))
  const warnedWindows = counts
    .map((count, index) =>
      exceedsLongLivedRecordRequestRate({
        count,
        windowIndex: index + 1,
      })
        ? index + 1
        : null,
    )
    .filter((windowIndex) => windowIndex !== null)

  expect(warnedWindows).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test('a final partial later window uses the full per-minute bound', () => {
  expect(exceedsLongLivedRecordRequestRate({ count: 1, windowIndex: 2 })).toBe(false)
  expect(exceedsLongLivedRecordRequestRate({ count: 7, windowIndex: 2 })).toBe(true)
})
