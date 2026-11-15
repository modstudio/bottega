import { afterEach, beforeEach, expect, test } from 'bun:test'
import { formatStopTime } from './stop-summary-time.ts'

const INSTANT = '2026-01-15T15:12:00.000Z'
let previousTimezone: string | undefined

beforeEach(() => {
  previousTimezone = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
})

afterEach(() => {
  if (previousTimezone === undefined) delete process.env.TZ
  else process.env.TZ = previousTimezone
})

test('a configured IANA zone renders a twelve-hour time with its abbreviation', () => {
  expect(formatStopTime(INSTANT, 'America/New_York')).toBe('10:12 AM EST')
})

test('an absent or invalid zone silently uses the process zone', () => {
  expect(formatStopTime(INSTANT)).toBe('7:12 AM PST')
  expect(formatStopTime(INSTANT, 'Mars/Olympus')).toBe('7:12 AM PST')
})
