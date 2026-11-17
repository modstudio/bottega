import { expect, test } from 'bun:test'
import {
  RECORD_KEYED_NOT_VISIBLE_CODE,
  recordKeyedNotVisibleRefusal,
  recordReadIsUuidKeyed,
} from './record-keyed-read.ts'

test('only UUID-keyed hosted reads are classified as keyed', () => {
  for (const read of ['by-id', 'for-run', 'for-runs', 'for-cursor', 'open-for-cursors'])
    expect(recordReadIsUuidKeyed('/v1/questions', read)).toBe(true)
  for (const route of [
    '/v1/task-flow/stages/01990000-0000-7000-8000-000000000001',
    '/v1/task-flow/texts/01990000-0000-7000-8000-000000000001',
    '/v1/task-flow/obligations/01990000-0000-7000-8000-000000000001',
  ])
    expect(recordReadIsUuidKeyed(route)).toBe(true)
  expect(recordReadIsUuidKeyed('/v1/task-flow', 'flow')).toBe(true)

  for (const read of ['inbox', 'rulings', 'waiting'])
    expect(recordReadIsUuidKeyed('/v1/questions', read)).toBe(false)
  expect(recordReadIsUuidKeyed('/v1/task-flow/stages')).toBe(false)
  expect(recordReadIsUuidKeyed('/v1/task-flow', 'task')).toBe(false)
})

test('keyed misses have one stable coded refusal', () => {
  expect(recordKeyedNotVisibleRefusal(2)).toEqual({
    error: 'not visible in your record spaces (2 memberships)',
    remedy:
      'the row is in a space you are not a member of, or it does not exist; join its space or check the id',
    code: RECORD_KEYED_NOT_VISIBLE_CODE,
  })
})
