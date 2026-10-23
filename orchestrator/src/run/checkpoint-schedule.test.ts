import { expect, test } from 'bun:test'
import { createCheckpointSchedule, decideCheckpoint } from './checkpoint-schedule.ts'

test('defers a due scheduled checkpoint while an execution is in flight', () => {
  expect(decideCheckpoint({ due: true, inFlightExecutions: 1, trigger: 'scheduled' })).toBe('defer')
})

test('takes the deferred scheduled checkpoint after executions finish', () => {
  expect(decideCheckpoint({ due: true, inFlightExecutions: 0, trigger: 'scheduled' })).toBe('take')
})

test('takes a limit checkpoint immediately while an execution is in flight', () => {
  expect(decideCheckpoint({ due: true, inFlightExecutions: 1, trigger: 'limit' })).toBe('take')
})

test('takes a checkpoint exactly once after the execution that deferred it finishes', () => {
  const taken: string[] = []
  const schedule = createCheckpointSchedule((trigger) => taken.push(trigger))

  schedule.executionStarted()
  expect(schedule.request('scheduled')).toBeNull()
  expect(taken).toEqual([])

  schedule.executionFinished()
  expect(taken).toEqual(['scheduled'])
  schedule.executionFinished()
  expect(taken).toEqual(['scheduled'])
})

test('waits for the last of two overlapping executions before taking a deferred checkpoint', () => {
  const taken: string[] = []
  const schedule = createCheckpointSchedule((trigger) => taken.push(trigger))

  schedule.executionStarted()
  schedule.executionStarted()
  schedule.request('scheduled')
  schedule.executionFinished()
  expect(taken).toEqual([])

  schedule.executionFinished()
  expect(taken).toEqual(['scheduled'])
})

test('takes a limit checkpoint immediately during an execution', () => {
  const taken: string[] = []
  const schedule = createCheckpointSchedule((trigger) => taken.push(trigger))

  schedule.executionStarted()
  expect(schedule.request('limit')).toBe(1)
  expect(taken).toEqual(['limit'])

  schedule.executionFinished()
  expect(taken).toEqual(['limit'])
})
