import { describe, expect, test } from 'bun:test'
import { metricCalendarDay } from './metric.ts'

function timestampWithLocalDay(iso: string, year: number, month: number, day: number): Date {
  const value = new Date(iso)
  value.getFullYear = () => year
  value.getMonth = () => month - 1
  value.getDate = () => day
  return value
}

describe('metric calendar', () => {
  test('keeps both sides of UTC midnight in the same local day', () => {
    const before = timestampWithLocalDay('2026-09-11T23:59:59Z', 2026, 9, 11)
    const after = timestampWithLocalDay('2026-09-12T00:00:01Z', 2026, 9, 11)
    expect(metricCalendarDay(before)).toBe('2026-09-11')
    expect(metricCalendarDay(after)).toBe('2026-09-11')
  })

  test('changes buckets at local midnight', () => {
    const before = timestampWithLocalDay('2026-09-12T03:59:59Z', 2026, 9, 11)
    const after = timestampWithLocalDay('2026-09-12T04:00:00Z', 2026, 9, 12)
    expect(metricCalendarDay(before)).toBe('2026-09-11')
    expect(metricCalendarDay(after)).toBe('2026-09-12')
  })
})
