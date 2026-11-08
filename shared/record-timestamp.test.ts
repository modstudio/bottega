import { expect, test } from 'bun:test'
import { nullableRecordDate, nullableRecordIso, recordDate } from './record-timestamp.ts'

test('keeps milliseconds from a Date returned by the record driver', () => {
  const source = new Date('2026-11-04T13:29:14.207Z')

  const converted = recordDate(source)

  expect(converted).not.toBe(source)
  expect(converted.getMilliseconds()).toBe(207)
  expect(converted.toISOString()).toBe('2026-11-04T13:29:14.207Z')
})

test('keeps milliseconds from a Postgres text timestamp', () => {
  expect(recordDate('2026-11-04 13:29:14.207+00').getMilliseconds()).toBe(207)
})

test('round-trips an ISO timestamp', () => {
  const value = '2026-11-04T13:29:14.207Z'

  expect(recordDate(value).toISOString()).toBe(value)
})

test('the nullable projections pass null through and keep a Date driver value to the millisecond', () => {
  const source = new Date('2026-11-04T13:29:14.207Z')

  expect(nullableRecordIso(source)).toBe('2026-11-04T13:29:14.207Z')
  expect(nullableRecordIso(null)).toBeNull()
  expect(nullableRecordDate(undefined)).toBeNull()
  expect(nullableRecordDate(source)?.getMilliseconds()).toBe(207)
})
