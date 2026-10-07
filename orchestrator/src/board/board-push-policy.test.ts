import { expect, test } from 'bun:test'
import {
  pendingForDelivery,
  renderPendingAcknowledgement,
  shouldRemind,
} from './board-push-policy.ts'

test('reminders inject once and then wait for the supplied interval', () => {
  const now = Date.parse('2026-10-07T12:00:00.000Z')
  expect(shouldRemind(null, now, 300)).toBe(true)
  expect(shouldRemind('2026-10-07T11:59:59.000Z', now, 300)).toBe(false)
  expect(shouldRemind('2026-10-07T11:55:00.000Z', now, 300)).toBe(true)
  expect(
    pendingForDelivery(
      [
        { id: '1', author: 'operator', title: 'A', body: 'B', deadline: 'D', deliveredAt: null },
        {
          id: '2',
          author: 'operator',
          title: 'A',
          body: 'B',
          deadline: 'D',
          deliveredAt: '2026-10-07T11:59:59.000Z',
        },
      ],
      now,
      300,
    ).map((notice) => notice.id),
  ).toEqual(['1'])
})

test('pending notice text has only the ruled fields in order', () => {
  expect(
    renderPendingAcknowledgement({
      id: 'notice-id',
      author: 'architect sender',
      title: 'Read this',
      body: 'The body.',
      deadline: '2026-10-07T13:00:00.000Z',
      deliveredAt: null,
    }),
  ).toBe(
    'Posted by: architect sender\nTitle: Read this\nBody: The body.\nDeadline: 2026-10-07T13:00:00.000Z\norch board ack notice-id',
  )
})
