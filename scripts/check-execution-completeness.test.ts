import { expect, test } from 'bun:test'
import { checkExecutionCardinality } from './check-execution-completeness.ts'

test('reports a planned check with no execution record', () => {
  expect(checkExecutionCardinality(['one', 'two'], ['one'])).toEqual([{ check: 'two', count: 0 }])
})

test('reports a planned check with duplicate execution records', () => {
  expect(checkExecutionCardinality(['one'], ['one', 'one'])).toEqual([{ check: 'one', count: 2 }])
})

test('accepts exactly one execution record for every planned check', () => {
  expect(checkExecutionCardinality(['one', 'two'], ['two', 'one'])).toEqual([])
})
