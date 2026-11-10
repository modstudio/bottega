import { expect, test } from 'bun:test'
import {
  decideRevisionPreflight,
  decideRevisionWrite,
  sameRecordValue,
} from './record-task-flow-write-decision.ts'

test('identical record values ignore recursive key order and timestamp spelling', () => {
  expect(
    sameRecordValue(
      { nested: { second: 2, first: 1 }, at: '2026-11-10T14:24:38Z' },
      { at: '2026-11-10T14:24:38.000Z', nested: { first: 1, second: 2 } },
    ),
  ).toBe(true)
  expect(sameRecordValue({ first: 1 }, { first: 2 })).toBe(false)
})

test('revision decisions distinguish a write, its retry, and a stale writer', () => {
  expect(decideRevisionWrite({ revision: 2, lastRequestId: null }, 2, 'request')).toEqual({
    kind: 'write',
  })
  expect(decideRevisionWrite({ revision: 3, lastRequestId: 'request' }, 2, 'request')).toEqual({
    kind: 'retry',
  })
  expect(decideRevisionWrite({ revision: 3, lastRequestId: 'other' }, 2, 'request')).toEqual({
    kind: 'conflict',
    currentRevision: 3,
  })
})

test('preflight accepts only all writes or all retries', () => {
  expect(decideRevisionPreflight(['write', 'write'])).toEqual({ kind: 'write' })
  expect(decideRevisionPreflight(['retry', 'retry'])).toEqual({ kind: 'retry' })
  expect(decideRevisionPreflight(['write', 'retry'])).toEqual({
    kind: 'partial-retry',
    index: 1,
  })
})
