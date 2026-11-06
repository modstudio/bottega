import { describe, expect, test } from 'bun:test'
import { TRACKER_FULL_READ_MS, trackerReadMode } from './tracker-read-mode.ts'

describe('tracker read mode', () => {
  const now = '2026-11-06T12:00:00.000Z'
  const recent = new Date(Date.parse(now) - TRACKER_FULL_READ_MS + 1).toISOString()

  test.each([
    ['undeclared filter', false, recent, recent],
    ['missing cursor', true, null, recent],
    ['missing full read', true, recent, null],
    [
      'daily full read due',
      true,
      recent,
      new Date(Date.parse(now) - TRACKER_FULL_READ_MS).toISOString(),
    ],
  ] as const)('%s uses a full read', (_label, declared, since, lastFullRead) => {
    expect(trackerReadMode({ declared, forceFull: false, since, lastFullRead, now })).toBe('full')
  })

  test('a declared filter with recent state uses an incremental read', () => {
    expect(
      trackerReadMode({
        declared: true,
        forceFull: false,
        since: recent,
        lastFullRead: recent,
        now,
      }),
    ).toBe('incremental')
  })

  test('a stored force-full flag overrides otherwise recent state', () => {
    expect(
      trackerReadMode({
        declared: true,
        forceFull: true,
        since: recent,
        lastFullRead: recent,
        now,
      }),
    ).toBe('full')
  })
})
