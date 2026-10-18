import { expect, test } from 'bun:test'
import {
  groupHistory,
  type HistoryDay,
  type HistoryEntry,
  runDuration,
  statusPath,
} from './history-model.ts'

const now = new Date('2026-10-16T15:00:00')
const ana = 'Ana'
const ben = 'Ben'
const status = (
  id: string,
  at: string,
  from: string | null,
  to: string,
  actor: string | null = null,
): HistoryEntry => ({ kind: 'status', id, at, from, to, actor })
const run = (id: string, at: string, agent: string, actor: string): HistoryEntry => ({
  kind: 'run',
  id,
  at,
  run: id,
  agent,
  job: 'implement',
  endedAt: null,
  running: false,
  actor,
})
const shape = (days: HistoryDay[]) =>
  days.map((day) =>
    day.blocks.map((block) =>
      block.kind === 'comment'
        ? 'comment'
        : `${block.actor ?? '?'}:${block.items.map((item) => item.kind).join(',')}`,
    ),
  )
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
  expect(shape(days)).toEqual([['?:status-run', 'comment', '?:status-run']])
  const older = days[0]?.blocks[2]
  const folded = older?.kind === 'cluster' ? older.items[0] : undefined
  expect(
    folded?.kind === 'status-run' && statusPath(folded.changes).map((step) => step.status),
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
  expect(days.map((day) => day.blocks.length)).toEqual([1, 1])
})

test('a filter shows only its kind', () => {
  const days = groupHistory(
    [comment('c', '2026-10-16T11:00:00'), status('a', '2026-10-16T09:00:00', null, 'open')],
    'comment',
    now,
  )
  expect(shape(days)).toEqual([['comment']])
})

test('durations read in the largest sensible unit', () => {
  expect(runDuration('2026-10-16T09:00:00', '2026-10-16T09:00:42')).toBe('42s')
  expect(runDuration('2026-10-16T09:00:00', '2026-10-16T09:09:00')).toBe('9m')
  expect(runDuration('2026-10-16T09:00:00', '2026-10-16T10:25:00')).toBe('1h 25m')
  expect(runDuration('2026-10-16T09:00:00', null)).toBeNull()
})

test("one person's events gather across agents, and another person starts a new cluster", () => {
  const days = groupHistory(
    [
      status('a', '2026-10-16T09:00:00', 'open', 'active', ana),
      run('r1', '2026-10-16T09:05:00', 'codex', ana),
      run('r2', '2026-10-16T09:30:00', 'claude', ben),
      status('b', '2026-10-16T10:00:00', 'active', 'review', ana),
      status('c', '2026-10-16T10:01:00', 'review', 'active', ana),
    ],
    'all',
    now,
  )
  expect(shape(days)).toEqual([['Ana:status-run', 'Ben:run', 'Ana:run,status-run']])
})
