import { expect, test } from 'bun:test'
import { reviewRoundWasApplied } from './review-round-application.ts'

test('a findings turn must start strictly after the last review was recorded', () => {
  expect(
    reviewRoundWasApplied('2026-11-20T00:00:00.000Z', [
      { startedAt: '2026-11-19T23:59:59.999Z' },
      { startedAt: '2026-11-20T00:00:00.000Z' },
    ]),
  ).toBeFalse()
  expect(
    reviewRoundWasApplied('2026-11-20T00:00:00.000Z', [{ startedAt: '2026-11-20T00:00:00.001Z' }]),
  ).toBeTrue()
})
