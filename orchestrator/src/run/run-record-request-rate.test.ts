import { expect, test } from 'bun:test'
import {
  exceedsLongLivedRecordRequestRate,
  LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX,
} from './run-record-request-rate.ts'

test('the long-lived request rate is allowed at the bound and warned just over it', () => {
  expect(
    exceedsLongLivedRecordRequestRate({
      count: LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX,
      elapsedMs: 60_000,
    }),
  ).toBe(false)
  expect(
    exceedsLongLivedRecordRequestRate({
      count: LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX + 1,
      elapsedMs: 60_000,
    }),
  ).toBe(true)
})
