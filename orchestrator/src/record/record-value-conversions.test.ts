import { expect, test } from 'bun:test'
import { outboxFailureDisposition } from './outbox-failure.ts'
import {
  nonnegativeInteger,
  nonnegativeRoundedInteger,
  nullableRoundedBigint,
  nullableUuid,
} from './record-value-conversions.ts'

function dispositionOf(run: () => unknown) {
  try {
    run()
  } catch (error) {
    return outboxFailureDisposition(error)
  }
  throw new Error('expected conversion to fail')
}

test('nullableRoundedBigint rounds fractional milliseconds and preserves null', () => {
  expect(nullableRoundedBigint(216.84812499999998, 'contention.duration_ms')).toBe(217n)
  expect(nullableRoundedBigint(null, 'contention.duration_ms')).toBeNull()
})

test('nullableRoundedBigint refuses a non-number through row validation', () => {
  expect(() => nullableRoundedBigint('', 'contention.duration_ms')).toThrow(
    'contention.duration_ms must be a finite number or null',
  )
})

test('invalid conversion values are row-fatal', () => {
  const invalidConversions = [
    () => nonnegativeInteger(-1, 'count'),
    () => nonnegativeRoundedInteger(Number.NaN, 'duration_ms'),
    () => nullableRoundedBigint('invalid', 'duration_ms'),
    () => nullableUuid('invalid', 'record_id'),
  ]
  expect(invalidConversions.map(dispositionOf)).toEqual([
    'row-fatal',
    'row-fatal',
    'row-fatal',
    'row-fatal',
  ])
})

test('nonnegativeRoundedInteger rounds fractional milliseconds and refuses invalid values', () => {
  expect(nonnegativeRoundedInteger(960626.5, 'context_review.interval_ms')).toBe(960627)
  expect(() => nonnegativeRoundedInteger(-1, 'context_review.interval_ms')).toThrow(
    'context_review.interval_ms must be a finite nonnegative number',
  )
  expect(() => nonnegativeRoundedInteger(Number.NaN, 'context_review.interval_ms')).toThrow(
    'context_review.interval_ms must be a finite nonnegative number',
  )
})
