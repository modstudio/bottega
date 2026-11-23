import { expect, test } from 'bun:test'
import { recordReadIsUuidKeyed, recordRequestReadKind } from './record-keyed-read.ts'
import { TASK_FLOW_UUID_READ_SELECTORS } from './record-task-flow-contract.ts'

test('only UUID-keyed hosted reads are classified as keyed', () => {
  for (const read of ['by-id', 'for-run', 'for-runs', 'for-cursor', 'open-for-cursors'])
    expect(recordReadIsUuidKeyed('/v1/questions', read)).toBe(true)
  for (const route of [
    '/v1/task-flow/stages/01990000-0000-7000-8000-000000000001',
    '/v1/task-flow/texts/01990000-0000-7000-8000-000000000001',
    '/v1/task-flow/obligations/01990000-0000-7000-8000-000000000001',
  ])
    expect(recordReadIsUuidKeyed(route)).toBe(true)
  const query = (values: Record<string, string>) => (name: string) => values[name]
  for (const selector of TASK_FLOW_UUID_READ_SELECTORS) {
    const readKind = recordRequestReadKind(
      '/v1/task-flow',
      query({
        [selector]: crypto.randomUUID(),
      }),
    )
    expect(readKind).toBe('flow')
    expect(recordReadIsUuidKeyed('/v1/task-flow', readKind)).toBe(true)
  }
  expect(recordReadIsUuidKeyed('/v1/task-flow/presence')).toBe(true)

  for (const read of ['inbox', 'rulings', 'waiting'])
    expect(recordReadIsUuidKeyed('/v1/questions', read)).toBe(false)
  expect(recordReadIsUuidKeyed('/v1/task-flow/stages')).toBe(false)
  expect(recordReadIsUuidKeyed('/v1/task-flow', 'task')).toBe(false)

  expect(recordRequestReadKind('/v1/questions', query({ read: 'by-id' }))).toBe('by-id')
  expect(recordRequestReadKind('/v1/questions', query({ read: 'inbox' }))).toBe('inbox')
  expect(recordRequestReadKind('/v1/questions/memberships', query({ read: 'inbox' }))).toBe('inbox')
  expect(recordRequestReadKind('/v1/task-flow', query({ taskKey: 'DEV-2384' }))).toBeUndefined()
  expect(recordReadIsUuidKeyed('/v1/task-flow', undefined)).toBe(false)
  expect(
    recordRequestReadKind(`/v1/task-flow/stages/${crypto.randomUUID()}`, query({})),
  ).toBeUndefined()
})

test('question memberships reads span every membership', () => {
  expect(recordReadIsUuidKeyed('/v1/questions/memberships', 'inbox')).toBe(true)
})
