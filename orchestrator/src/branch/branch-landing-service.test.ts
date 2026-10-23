import { expect, test } from 'bun:test'
import { decideLandingTaskKey } from './branch-landing-service.ts'

test('landing task-key decision combines recorded and branch-named keys', () => {
  expect(decideLandingTaskKey(['DEV-1'], 'feature', ['DEV'])).toEqual({
    attributed: true,
    taskKey: 'DEV-1',
  })
  expect(decideLandingTaskKey([], 'DEV-2-feature', ['DEV'])).toEqual({
    attributed: true,
    taskKey: 'DEV-2',
  })
  expect(decideLandingTaskKey(['DEV-3'], 'DEV-2-feature', ['DEV'])).toEqual({
    attributed: false,
    keys: ['DEV-3', 'DEV-2'],
  })
})
