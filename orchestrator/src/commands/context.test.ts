import { expect, test } from 'bun:test'
import { contextClearReport } from './context.ts'

test('context clear reports an empty holder as a successful zero-item clear', () => {
  expect(contextClearReport({ task: 'DEV-2270', removed: 0 })).toBe(
    'context: cleared 0 items on DEV-2270',
  )
})
