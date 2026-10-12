import { expect, test } from 'bun:test'
import { isSameStatusEvent } from './status-event-identity.ts'

const base = {
  task: { id: null as string | null, key: 'DEV-1' },
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

test('known equal task ids are the same event even when the key snapshot differs', () => {
  expect(
    isSameStatusEvent(
      { ...base, task: { id: 'task-1', key: 'DEV-1' } },
      { ...base, task: { id: 'task-1', key: 'DEV-9' } },
    ),
  ).toBe(true)
})

test('the key is used only when a task id is unknown on one side', () => {
  expect(
    isSameStatusEvent(base, { ...base, task: { id: 'task-1', key: 'DEV-1' } }),
  ).toBe(true)
  expect(
    isSameStatusEvent(
      { ...base, task: { id: 'task-1', key: 'DEV-1' } },
      { ...base, task: { id: 'task-2', key: 'DEV-1' } },
    ),
  ).toBe(false)
  expect(
    isSameStatusEvent(base, { ...base, task: { id: null, key: 'DEV-2' } }),
  ).toBe(false)
})

test('a different task, new status, or instant is another event', () => {
  expect(isSameStatusEvent(base, { ...base, task: { id: null, key: 'DEV-2' } })).toBe(false)
  expect(isSameStatusEvent(base, { ...base, toStatus: 'review' })).toBe(false)
  expect(isSameStatusEvent(base, { ...base, at: '2026-10-12T10:00:00.001Z' })).toBe(false)
})
