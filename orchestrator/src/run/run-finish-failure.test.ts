import { expect, test } from 'bun:test'
import { shouldWriteFinishFailure } from './run-finish-failure.ts'

test('a finish failure replaces only a non-terminal run status', () => {
  expect(shouldWriteFinishFailure('running')).toBe(true)
  expect(shouldWriteFinishFailure('asking')).toBe(true)
  expect(shouldWriteFinishFailure('ok')).toBe(false)
  expect(shouldWriteFinishFailure('failed')).toBe(false)
  expect(shouldWriteFinishFailure('stale')).toBe(false)
  expect(shouldWriteFinishFailure('stopped')).toBe(false)
})
