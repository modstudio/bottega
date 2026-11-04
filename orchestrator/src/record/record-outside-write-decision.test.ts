import { describe, expect, test } from 'bun:test'
import {
  OUTSIDE_BODY_MAX_CHARS,
  OUTSIDE_LINK_MAX,
  OUTSIDE_MIN_ACCOUNT_AGE_MS,
  OUTSIDE_WRITES_PER_DAY,
  OUTSIDE_WRITES_PER_HOUR,
  outsideWriteDecision,
} from './record-outside-write-decision.ts'

const now = new Date('2026-11-04T12:00:00.000Z')
const base = {
  now,
  createdAt: new Date(now.getTime() - OUTSIDE_MIN_ACCOUNT_AGE_MS),
  emailVerified: true,
  body: 'hello',
  writesLastHour: 0,
  writesLastDay: 0,
  oldestWriteLastHour: null,
  oldestWriteLastDay: null,
}

describe('outside write decision', () => {
  test.each([
    ['unverified email', { emailVerified: false }, 403, 'verify your email'],
    [
      'new account',
      { createdAt: new Date(base.createdAt.getTime() + 1) },
      403,
      '2026-11-04T12:00:00.001Z',
    ],
    ['long body', { body: 'x'.repeat(OUTSIDE_BODY_MAX_CHARS + 1) }, 413, '2000 characters'],
    [
      'too many links',
      {
        body: Array.from(
          { length: OUTSIDE_LINK_MAX + 1 },
          (_, index) => `https://e.test/${index}`,
        ).join(' '),
      },
      400,
      'at most 2',
    ],
    [
      'hour rate',
      {
        writesLastHour: OUTSIDE_WRITES_PER_HOUR,
        oldestWriteLastHour: new Date('2026-11-04T11:10:00Z'),
      },
      429,
      '2026-11-04T12:10:00.000Z',
    ],
    [
      'day rate',
      {
        writesLastDay: OUTSIDE_WRITES_PER_DAY,
        oldestWriteLastDay: new Date('2026-11-03T13:00:00Z'),
      },
      429,
      '2026-11-04T13:00:00.000Z',
    ],
  ])('refuses %s', (_name, changed, status, text) => {
    const decision = outsideWriteDecision({ ...base, ...changed })
    expect(decision).toMatchObject({ allowed: false, status })
    if (!decision.allowed) expect(decision.refusal).toContain(text)
  })

  test.each([
    ['age boundary', {}],
    ['body boundary', { body: 'x'.repeat(OUTSIDE_BODY_MAX_CHARS) }],
    ['link boundary', { body: 'http://a.test https://b.test' }],
    ['hour below limit', { writesLastHour: OUTSIDE_WRITES_PER_HOUR - 1 }],
    ['day below limit', { writesLastDay: OUTSIDE_WRITES_PER_DAY - 1 }],
  ])('allows %s', (_name, changed) => {
    expect(outsideWriteDecision({ ...base, ...changed })).toEqual({ allowed: true })
  })
})
