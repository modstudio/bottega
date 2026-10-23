import { expect, test } from 'bun:test'
import { runTestWorkerEnvironment } from './run-test-workers.ts'

test('recipe test worker values take precedence over run defaults', () => {
  expect(runTestWorkerEnvironment({}, 16)).toEqual({
    BOTTEGA_TEST_WORKERS: '4',
    VITEST_MAX_WORKERS: '4',
  })
  expect(
    runTestWorkerEnvironment({ BOTTEGA_TEST_WORKERS: '9', VITEST_MAX_WORKERS: '7' }, 16),
  ).toMatchObject({ BOTTEGA_TEST_WORKERS: '9', VITEST_MAX_WORKERS: '7' })
})
