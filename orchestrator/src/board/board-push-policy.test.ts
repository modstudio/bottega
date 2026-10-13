import { expect, test } from 'bun:test'
import { messageIsDueForPush } from './board-push-policy.ts'

const beganAt = '2026-10-13T12:00:00.000Z'

test('push delivery starts with the reader except when acknowledgement is required', () => {
  for (const [postedAt, acknowledgementRequired, expected] of [
    ['2026-10-13T11:59:59.999Z', false, false],
    [beganAt, false, true],
    ['2026-10-13T12:00:00.001Z', false, true],
    ['2026-10-13T11:59:59.999Z', true, true],
    [beganAt, true, true],
    ['2026-10-13T12:00:00.001Z', true, true],
  ] as const)
    expect(messageIsDueForPush({ postedAt, readerBeganAt: beganAt, acknowledgementRequired })).toBe(
      expected,
    )
})
