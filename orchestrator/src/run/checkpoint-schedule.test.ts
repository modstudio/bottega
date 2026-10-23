import { expect, test } from 'bun:test'
import { decideCheckpoint } from './checkpoint-schedule.ts'

test('defers a due scheduled checkpoint while an execution is in flight', () => {
  expect(decideCheckpoint({ due: true, inFlightExecutions: 1, trigger: 'scheduled' })).toBe('defer')
})

test('takes the deferred scheduled checkpoint after executions finish', () => {
  expect(decideCheckpoint({ due: true, inFlightExecutions: 0, trigger: 'scheduled' })).toBe('take')
})

test('takes a limit checkpoint immediately while an execution is in flight', () => {
  expect(decideCheckpoint({ due: true, inFlightExecutions: 1, trigger: 'limit' })).toBe('take')
})
