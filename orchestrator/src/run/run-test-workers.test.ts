import { expect, test } from 'bun:test'
import { runTestWorkerCount, runTestWorkerEnvironment } from './run-test-workers.ts'

test('repository test worker arithmetic floors at one', () => {
  expect(runTestWorkerCount(16)).toBe(4)
  expect(runTestWorkerCount(7)).toBe(1)
  expect(runTestWorkerCount(1)).toBe(1)
})

test('recipe test worker values take precedence over run defaults', () => {
  expect(runTestWorkerEnvironment({}, 16)).toEqual({
    ORCH_TEST_WORKERS: '4',
    VITEST_MAX_WORKERS: '4',
  })
  expect(
    runTestWorkerEnvironment({ ORCH_TEST_WORKERS: '9', VITEST_MAX_WORKERS: '7' }, 16),
  ).toMatchObject({ ORCH_TEST_WORKERS: '9', VITEST_MAX_WORKERS: '7' })
})
