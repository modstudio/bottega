import { describe, expect, test } from 'bun:test'
import { deduplicateHardLinkedBytes, STORAGE_WALK_ENTRY_LIMIT } from '../storage-walk.ts'
import {
  diskPressureCondition,
  FREE_SPACE_ABSOLUTE_FLOOR_BYTES,
  largestRuns,
  storageMeasurement,
  storagePressureDecision,
} from './storage-conditions.ts'

describe('storage pressure decision', () => {
  const GiB = 1024 ** 3

  test('fires below and clears at the proportional threshold', () => {
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
    expect(
      storagePressureDecision({
        path: '/state',
        freeBytes: 100 * GiB + 1,
        totalBytes,
        error: null,
      }),
    ).toMatchObject({ pressured: false, thresholdBytes: 100 * GiB })
  })

  test('fires below and clears at the absolute floor', () => {
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
    expect(
      storagePressureDecision({
        path: '/state',
        freeBytes: FREE_SPACE_ABSOLUTE_FLOOR_BYTES + 1,
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

  test('builds the condition and ranked kinds from measured facts', () => {
    const decision = diskPressureCondition(
      { path: '/state', freeBytes: 1, totalBytes: 100 * GiB, error: null },
      [
        {
          label: 'runs artifacts',
          measurement: { bytes: 90, entries: 1, state: 'partial', detail: 'capped' },
        },
        {
          label: 'project worktrees',
          measurement: { bytes: 40, entries: 2, state: 'complete', detail: null },
        },
      ],
      Date.parse('2026-10-18T12:00:00.000Z'),
    )
    expect(decision.largestKinds).toEqual([
      'runs artifacts 90 bytes (at least)',
      'project worktrees 40 bytes',
    ])
    expect(decision.condition).toMatchObject({
      kind: 'disk-pressure',
      since: '2026-10-18T12:00:00.000Z',
      remedy: {
        reportCommand: 'machine storage',
        reclaimCommand: 'machine reclaim worktree, sandbox, or stale-run',
      },
    })
  })
})

describe('storage totals', () => {
  test('counts two paths to one multiply linked inode once while retaining both entries', () => {
    const observations = deduplicateHardLinkedBytes([
      { bytes: 4096, hardLinkKey: '12:34', path: 'first' },
      { bytes: 4096, hardLinkKey: '12:34', path: 'second' },
    ])
    expect(observations.map(({ path, bytes }) => ({ path, bytes }))).toEqual([
      { path: 'first', bytes: 4096 },
      { path: 'second', bytes: 0 },
    ])
  })

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

test('largest runs are ordered by size and carry age, liveness, and partial state', () => {
  const sizes = new Map([
    [7, 50],
    [3, 80],
    [2, 80],
    [9, 20],
  ])
  const facts = new Map<number, { startedAt: string; status: string }>([
    [2, { startedAt: '2026-10-18T11:00:00.000Z', status: 'running' }],
    [3, { startedAt: '2026-10-18T10:00:00.000Z', status: 'ok' }],
    [7, { startedAt: 'unreadable', status: 'failed' }],
  ])
  expect(largestRuns(sizes, facts, Date.parse('2026-10-18T12:00:00.000Z'), true)).toEqual({
    state: 'partial',
    runs: [
      { runId: 2, bytes: 80, ageMs: 3_600_000, status: 'live', state: 'partial' },
      { runId: 3, bytes: 80, ageMs: 7_200_000, status: 'terminal', state: 'partial' },
      { runId: 7, bytes: 50, ageMs: null, status: 'terminal', state: 'partial' },
      { runId: 9, bytes: 20, ageMs: null, status: 'terminal', state: 'partial' },
    ],
  })
})
