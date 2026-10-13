import { expect, test } from 'bun:test'
import { messageIsDueForPush, selectPushNotices } from './board-push-policy.ts'

const beganAt = '2026-10-13T12:00:00.000Z'

test('push delivery starts with the reader regardless of acknowledgement', () => {
  expect(
    messageIsDueForPush({ postedAt: '2026-10-13T11:59:59.999Z', readerBeganAt: beganAt }),
  ).toBeFalse()
  expect(messageIsDueForPush({ postedAt: beganAt, readerBeganAt: beganAt })).toBeTrue()
  expect(
    messageIsDueForPush({ postedAt: '2026-10-13T12:00:00.001Z', readerBeganAt: beganAt }),
  ).toBeTrue()

  const candidates = [
    { createdAt: '2026-10-13T11:59:59.999Z', acknowledgementRequired: true },
    { createdAt: beganAt, acknowledgementRequired: false },
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
