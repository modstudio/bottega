import { expect, test } from 'bun:test'
import {
  exceedsLongLivedRecordRequestRate,
  LONG_LIVED_RECORD_REQUEST_ALLOWANCE,
  LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX,
} from './run-record-request-rate.ts'

test('short-lived startup requests stay within the long-lived request allowance', () => {
  expect(exceedsLongLivedRecordRequestRate({ count: 30, elapsedMs: 20_000 })).toBe(false)
  expect(
    exceedsLongLivedRecordRequestRate({
      count: LONG_LIVED_RECORD_REQUEST_ALLOWANCE,
      elapsedMs: 1_000,
    }),
  ).toBe(false)
})

test('a sustained long-lived request rate is warned', () => {
  expect(exceedsLongLivedRecordRequestRate({ count: 900, elapsedMs: 900_000 })).toBe(true)
})

test('the long-lived request rate is allowed at the bound and warned just over it', () => {
  expect(
    exceedsLongLivedRecordRequestRate({
      count: LONG_LIVED_RECORD_REQUEST_ALLOWANCE + LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX,
      elapsedMs: 60_000,
    }),
  ).toBe(false)
  expect(
    exceedsLongLivedRecordRequestRate({
      count: LONG_LIVED_RECORD_REQUEST_ALLOWANCE + LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX + 1,
      elapsedMs: 60_000,
    }),
  ).toBe(true)
})
