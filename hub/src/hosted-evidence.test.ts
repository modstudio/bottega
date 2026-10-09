import { expect, test } from 'bun:test'
import {
  type DayEvidence,
  hostedDayWrite,
  hostedIntervalWrite,
  type IntervalEvidence,
} from './hosted-evidence.ts'

const interval = {
  id: 'client-id',
  source: 'orch',
  ref: 'orch:1',
  start_at: '2026-10-08T00:00:00.000Z',
} as IntervalEvidence

const day = { id: 'client-id', day: '2026-10-08' } as DayEvidence

test('an unknown interval id with an existing tuple names both ids and the tuple', () => {
  expect(() => hostedIntervalWrite(interval, null, 'hosted-id')).toThrow(
    'interval identity conflict: tuple (orch, orch:1, 2026-10-08T00:00:00.000Z) belongs to UUID hosted-id, not incoming UUID client-id',
  )
})

test('an unknown day id with an existing date names both ids and the date', () => {
  expect(() => hostedDayWrite(day, null, 'hosted-id')).toThrow(
    'day identity conflict: date 2026-10-08 belongs to UUID hosted-id, not incoming UUID client-id',
  )
})

test('a known interval and day id update', () => {
  expect(hostedIntervalWrite(interval, interval.id, interval.id)).toBe('update')
  expect(hostedDayWrite(day, day.id, day.id)).toBe('update')
})

test('a new interval tuple and day insert', () => {
  expect(hostedIntervalWrite(interval, null, null)).toBe('insert')
  expect(hostedDayWrite(day, null, null)).toBe('insert')
})
