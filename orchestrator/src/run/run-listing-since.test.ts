import { expect, test } from 'bun:test'
import { parseRunListSince } from './run-listing-since.ts'

test('run-list --since normalizes offsets and treats an empty value as absent', () => {
  expect(parseRunListSince('2026-11-19T01:02:03-05:00')).toBe('2026-11-19T06:02:03.000Z')
  expect(parseRunListSince('')).toBeUndefined()
})

test('run-list --since refuses a malformed instant with the accepted form', () => {
  expect(() => parseRunListSince('nonsense')).toThrow(
    'provide --since as an ISO 8601 timestamp, for example 2026-11-19T06:02:03.000Z',
  )
})
