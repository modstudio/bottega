import { describe, expect, test } from 'bun:test'
import {
  FREE_SPACE_ABSOLUTE_FLOOR_BYTES,
  largestRuns,
  STORAGE_WALK_ENTRY_LIMIT,
  storageMeasurement,
  storagePressureDecision,
} from './storage-report.ts'

describe('storage pressure decision', () => {
  const GiB = 1024 ** 3

  test('fires immediately below and clears at the proportional threshold', () => {
    const totalBytes = 1_000 * GiB
    expect(
      storagePressureDecision({
        path: '/state',
        freeBytes: 100 * GiB - 1,
        totalBytes,
        error: null,
      }),
    ).toMatchObject({ pressured: true, thresholdBytes: 100 * GiB })
    expect(
      storagePressureDecision({ path: '/state', freeBytes: 100 * GiB, totalBytes, error: null }),
    ).toMatchObject({ pressured: false, thresholdBytes: 100 * GiB })
  })

  test('fires immediately below and clears at the absolute floor', () => {
    const totalBytes = 100 * GiB
    expect(
      storagePressureDecision({
        path: '/state',
        freeBytes: FREE_SPACE_ABSOLUTE_FLOOR_BYTES - 1,
        totalBytes,
        error: null,
      }),
    ).toMatchObject({ pressured: true, thresholdBytes: FREE_SPACE_ABSOLUTE_FLOOR_BYTES })
    expect(
      storagePressureDecision({
        path: '/state',
        freeBytes: FREE_SPACE_ABSOLUTE_FLOOR_BYTES,
        totalBytes,
        error: null,
      }),
    ).toMatchObject({ pressured: false, thresholdBytes: FREE_SPACE_ABSOLUTE_FLOOR_BYTES })
  })

  test('does not invent a pressure verdict from an unreadable size', () => {
    expect(
      storagePressureDecision({
        path: '/state',
        freeBytes: null,
        totalBytes: null,
        error: 'permission denied',
      }),
    ).toEqual({ pressured: false, thresholdBytes: null, error: 'permission denied' })
  })
})

describe('storage totals', () => {
  test('labels an entry-capped total as a partial lower bound', () => {
    expect(
      storageMeasurement({ bytes: 41, entries: STORAGE_WALK_ENTRY_LIMIT, stoppedAtLimit: true }),
    ).toEqual({
      bytes: 41,
      entries: STORAGE_WALK_ENTRY_LIMIT,
      state: 'partial',
      detail: `at least 41 bytes and ${STORAGE_WALK_ENTRY_LIMIT} entries; walk stopped at the ${STORAGE_WALK_ENTRY_LIMIT}-entry cap`,
    })
  })

  test('uses null rather than zero for a wholly unreadable size', () => {
    expect(storageMeasurement({ bytes: 0, entries: 0, unreadable: 'permission denied' })).toEqual({
      bytes: null,
      entries: null,
      state: 'unreadable',
      detail: 'permission denied',
    })
  })
})

test('largest runs are ordered by size with stable ids and carry age and liveness', () => {
  const sizes = new Map([
    [7, 50],
    [3, 80],
    [2, 80],
    [9, 20],
  ])
  const facts = new Map([
    [2, { startedAt: '2026-10-18T11:00:00.000Z', status: 'running' }],
    [3, { startedAt: '2026-10-18T10:00:00.000Z', status: 'ok' }],
    [7, { startedAt: 'unreadable', status: 'failed' }],
  ])
  expect(largestRuns(sizes, facts, Date.parse('2026-10-18T12:00:00.000Z'))).toEqual([
    { runId: 2, bytes: 80, ageMs: 3_600_000, status: 'live' },
    { runId: 3, bytes: 80, ageMs: 7_200_000, status: 'terminal' },
    { runId: 7, bytes: 50, ageMs: null, status: 'terminal' },
    { runId: 9, bytes: 20, ageMs: null, status: 'terminal' },
  ])
})
