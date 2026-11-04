import { expect, test } from 'bun:test'
import { parseChangedAfter } from './support.ts'

test('changed-after validation owns incompatible flags at the command edge', () => {
  expect(() => parseChangedAfter({ value: '-1' })).toThrow(
    '--changed-after must be a non-negative integer',
  )
  expect(() => parseChangedAfter({ value: '1', since: '2026-11-03' })).toThrow(
    '--since and --changed-after cannot be combined',
  )
  expect(() => parseChangedAfter({ value: '1', hasRequestedRuns: true })).toThrow(
    '--id and --changed-after cannot be combined',
  )
  expect(() => parseChangedAfter({ value: '1', jsonV1: true })).toThrow(
    '--changed-after cannot be combined with --json 1; use --json (v2)',
  )
  expect(() => parseChangedAfter({ value: '1', limit: '10' })).toThrow(
    '--limit and --changed-after cannot be combined',
  )
})
