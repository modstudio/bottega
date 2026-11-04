import { expect, test } from 'bun:test'
import { parseChangedAfter } from './support.ts'

test('changed-after validation owns incompatible flags at the command edge', () => {
  expect(() => parseChangedAfter({ value: '-1' })).toThrow(
    '--changed-after must be a non-negative integer',
  )
  expect(() => parseChangedAfter({ value: '1', since: '2026-11-03', json: true })).toThrow(
    '--since and --changed-after cannot be combined',
  )
  expect(() => parseChangedAfter({ value: '1', hasRequestedRuns: true, json: true })).toThrow(
    '--id and --changed-after cannot be combined',
  )
  expect(() => parseChangedAfter({ value: '1' })).toThrow('--changed-after requires --json')
  expect(() => parseChangedAfter({ value: '1', json: true, jsonV1: true })).toThrow(
    '--changed-after cannot be combined with --json v1; use --json (v2)',
  )
  expect(() => parseChangedAfter({ value: '1', json: true, limit: '10' })).toThrow(
    '--limit and --changed-after cannot be combined',
  )
  expect(() => parseChangedAfter({ value: '1', json: true, job: 'implement' })).toThrow(
    '--job and --changed-after cannot be combined',
  )
  expect(() => parseChangedAfter({ value: '1', json: true, agent: 'codex' })).toThrow(
    '--agent and --changed-after cannot be combined',
  )
  expect(() => parseChangedAfter({ value: '1', json: true, live: true })).toThrow(
    '--live and --changed-after cannot be combined',
  )
  expect(() => parseChangedAfter({ value: '1', json: true, unscored: true })).toThrow(
    '--unscored and --changed-after cannot be combined',
  )
})
