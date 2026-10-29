import { expect, test } from 'bun:test'
import { nullableRoundedBigint } from './record-value-conversions.ts'

test('nullableRoundedBigint rounds fractional milliseconds and preserves null', () => {
  expect(nullableRoundedBigint(216.84812499999998, 'contention.duration_ms')).toBe(217n)
  expect(nullableRoundedBigint(null, 'contention.duration_ms')).toBeNull()
})

test('nullableRoundedBigint refuses a non-number through row validation', () => {
  expect(() => nullableRoundedBigint('', 'contention.duration_ms')).toThrow(
    'contention.duration_ms must be a finite number or null',
  )
})
