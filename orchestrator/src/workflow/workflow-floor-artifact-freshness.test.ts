import { expect, test } from 'bun:test'
import { TIMED_FRESHNESS as FRESHNESS } from './workflow-floor-artifact-freshness.ts'

test('untimed mutable artifacts preserve their kind-specific notice', () => {
  expect(FRESHNESS.notice(FRESHNESS.task, null, '2026-11-20T12:00:00.000Z')).toBe(
    'freshness unchecked: the tracker returns no task update time',
  )
  expect(FRESHNESS.notice(FRESHNESS.taskComment, undefined, '2026-11-20T12:00:00.000Z')).toBe(
    'freshness unchecked: external tracker returns no comment time',
  )
})

test('timed mutable artifacts require a write during the active step', () => {
  expect(() =>
    FRESHNESS.notice(FRESHNESS.task, '2026-11-19T12:00:00.000Z', '2026-11-20T12:00:00.000Z'),
  ).toThrow('task record time is 2026-11-19T12:00:00.000Z')
  expect(
    FRESHNESS.notice(FRESHNESS.task, '2026-11-21T12:00:00.000Z', '2026-11-20T12:00:00.000Z'),
  ).toBeNull()
})
