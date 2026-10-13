import { expect, test } from 'bun:test'
import { messageIsDueForPush, selectPushNotices } from './board-push-policy.ts'

const beganAt = '2026-10-13T12:00:00.000Z'

test('push delivery starts with the reader except for standing messages', () => {
  expect(
    messageIsDueForPush({
      postedAt: '2026-10-13T11:59:59.999Z',
      readerBeganAt: beganAt,
      purpose: 'information',
    }),
  ).toBeFalse()
  expect(
    messageIsDueForPush({ postedAt: beganAt, readerBeganAt: beganAt, purpose: 'request' }),
  ).toBeTrue()
  expect(
    messageIsDueForPush({
      postedAt: '2026-10-13T12:00:00.001Z',
      readerBeganAt: beganAt,
      purpose: 'standing',
    }),
  ).toBeTrue()
  expect(
    messageIsDueForPush({
      postedAt: '2026-10-13T11:59:59.999Z',
      readerBeganAt: beganAt,
      purpose: 'standing',
    }),
  ).toBeTrue()

  const candidates = [
    {
      createdAt: '2026-10-13T11:59:59.999Z',
      acknowledgementRequired: true,
      purpose: 'request' as const,
    },
    { createdAt: beganAt, acknowledgementRequired: false, purpose: 'information' as const },
  ]
  expect(selectPushNotices(beganAt, candidates)).toEqual({
    notices: [candidates[1]!],
    withheldOlderCount: 1,
  })
  expect(selectPushNotices(null, candidates)).toEqual({
    notices: candidates,
    withheldOlderCount: 0,
  })
})
