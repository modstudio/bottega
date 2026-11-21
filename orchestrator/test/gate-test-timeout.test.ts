import { expect, test } from 'bun:test'
import { CI_TEST_HANG_TIMEOUT_MS, gateTestTimeoutArguments } from './gate-test-timeout.ts'

test('uses the CI hang timeout only in CI', () => {
  expect(gateTestTimeoutArguments(true)).toEqual([`--timeout=${CI_TEST_HANG_TIMEOUT_MS}`])
  expect(gateTestTimeoutArguments(false)).toEqual([])
})
