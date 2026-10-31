import { expect, test } from 'bun:test'
import { isSameStatusEvent } from './status-event-identity.ts'

const base = {
  taskId: 'task-1' as string | null,
  toStatus: 'active',
  at: '2026-10-12T10:00:00.000Z',
}

test('the same task, new status, and instant are one event', () => {
  expect(
    isSameStatusEvent(base, {
      ...base,
      at: new Date('2026-10-12T10:00:00.000Z'),
    }),
  ).toBe(true)
  expect(isSameStatusEvent(base, { ...base, at: '2026-10-12T10:00:00+00:00' })).toBe(true)
})

test('an unknown task id matches no event, not even another unknown one', () => {
  expect(isSameStatusEvent({ ...base, taskId: null }, { ...base, taskId: null })).toBe(false)
  expect(isSameStatusEvent(base, { ...base, taskId: null })).toBe(false)
})

test('a different task, new status, or instant is another event', () => {
  expect(isSameStatusEvent(base, { ...base, taskId: 'task-2' })).toBe(false)
  expect(isSameStatusEvent(base, { ...base, toStatus: 'review' })).toBe(false)
  expect(isSameStatusEvent(base, { ...base, at: '2026-10-12T10:00:00.001Z' })).toBe(false)
})
