import { expect, test } from 'bun:test'
import { boardPushDecision } from './board-push-policy.ts'

const clock = Date.parse('2026-10-16T12:00:00.000Z')
const postedAt = '2026-10-16T11:00:00.000Z'

const decision = (input: Partial<Parameters<typeof boardPushDecision>[0]> = {}) =>
  boardPushDecision({
    acknowledgementRequired: true,
    postedAt,
    acknowledgementDeadline: '2026-10-16T13:00:00.000Z',
    expiresAt: '2026-10-17T12:00:00.000Z',
    purpose: 'request',
    readerBeganAt: '2026-10-16T10:00:00.000Z',
    clock,
    ...input,
  })

test('acknowledgement delivery ends at its deadline and belongs only to sessions already running', () => {
  expect(decision({ acknowledgementDeadline: '2026-10-16T11:59:59.999Z' })).toBe('withheld')
  expect(
    decision({
      acknowledgementDeadline: '2026-10-16T11:59:59.999Z',
      readerBeganAt: '2026-10-16T11:00:00.001Z',
    }),
  ).toBe('withheld')
  expect(decision()).toBe('acknowledgement')
  expect(decision({ purpose: 'standing', readerBeganAt: '2026-10-16T11:00:00.001Z' })).toBe(
    'withheld',
  )
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'standing',
      readerBeganAt: '2026-10-16T11:00:00.001Z',
    }),
  ).toBe('ordinary')
})

test('reported notice 01a13fd6 is withheld from a session started today', () => {
  expect(
    decision({
      postedAt: '2026-10-15T13:53:00.000Z',
      acknowledgementDeadline: '2026-10-15T14:53:00.000Z',
      expiresAt: '2026-10-22T13:53:00.000Z',
      purpose: 'standing',
      readerBeganAt: '2026-10-16T12:00:00.000Z',
    }),
  ).toBe('withheld')
})
