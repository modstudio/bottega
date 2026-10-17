import { expect, test } from 'bun:test'
import { groupHistory, type HistoryEntry, runDuration, statusPath } from './history-model.ts'

const now = new Date('2026-10-16T15:00:00')
const status = (id: string, at: string, from: string | null, to: string): HistoryEntry => ({
  kind: 'status',
  id,
  at,
  from,
  to,
})
const comment = (id: string, at: string): HistoryEntry => ({ kind: 'comment', id, at, body: id })

test('adjacent status changes fold into one run that reads oldest first', () => {
  const days = groupHistory(
    [
      status('a', '2026-10-16T09:00:00', 'open', 'active'),
      status('b', '2026-10-16T10:00:00', 'active', 'review'),
      comment('c', '2026-10-16T11:00:00'),
      status('d', '2026-10-16T12:00:00', 'review', 'done'),
    ],
    'all',
    now,
  )
  expect(days.map((day) => day.label)).toEqual(['Today'])
  const kinds = days[0]?.items.map((item) => item.kind)
  expect(kinds).toEqual(['status-run', 'comment', 'status-run'])
  const older = days[0]?.items[2]
  expect(
    older?.kind === 'status-run' && statusPath(older.changes).map((step) => step.status),
  ).toEqual(['open', 'active', 'review'])
})

test('changes on either side of midnight land in separate days', () => {
  const days = groupHistory(
    [
      status('a', '2026-10-15T23:30:00', 'open', 'active'),
      status('b', '2026-10-16T00:30:00', 'active', 'review'),
    ],
    'all',
    now,
  )
  expect(days.map((day) => day.label)).toEqual(['Today', 'Yesterday'])
  expect(days.map((day) => day.items.length)).toEqual([1, 1])
})

test('a filter shows only its kind', () => {
  const days = groupHistory(
    [comment('c', '2026-10-16T11:00:00'), status('a', '2026-10-16T09:00:00', null, 'open')],
    'comment',
    now,
  )
  expect(days.flatMap((day) => day.items.map((item) => item.kind))).toEqual(['comment'])
})

test('durations read in the largest sensible unit', () => {
  expect(runDuration('2026-10-16T09:00:00', '2026-10-16T09:00:42')).toBe('42s')
  expect(runDuration('2026-10-16T09:00:00', '2026-10-16T09:09:00')).toBe('9m')
  expect(runDuration('2026-10-16T09:00:00', '2026-10-16T10:25:00')).toBe('1h 25m')
  expect(runDuration('2026-10-16T09:00:00', null)).toBeNull()
})
