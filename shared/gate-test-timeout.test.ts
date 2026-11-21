import { expect, test } from 'bun:test'
import {
  CI_TEST_HANG_TIMEOUT_MS,
  checkSingleBunTestScript,
  checkSuiteTestTimeoutArguments,
  gateTestTimeoutArguments,
  isBunUnitTestCommand,
} from './gate-test-timeout.ts'

const timeout = `--timeout=${CI_TEST_HANG_TIMEOUT_MS}`

test('uses the CI hang timeout only in CI', () => {
  expect(gateTestTimeoutArguments(true)).toEqual([timeout])
  expect(gateTestTimeoutArguments(false)).toEqual([])
})

test('requires the CI timeout on every Bun unit-test command only in CI', () => {
  const ciCommands = [
    { argv: ['bun', 'run', 'test', timeout], unitTests: true },
    { argv: ['bun', 'run', 'build'], unitTests: false },
    { argv: ['python3', '-m', 'unittest'], unitTests: true },
  ]
  expect(() => checkSuiteTestTimeoutArguments(ciCommands, true)).not.toThrow()
  expect(isBunUnitTestCommand(ciCommands[2]!)).toBe(false)
  expect(() =>
    checkSuiteTestTimeoutArguments([{ argv: ['bun', 'run', 'test'], unitTests: true }], true),
  ).toThrow(`CI Bun unit-test command must carry ${timeout}: bun run test`)

  const localCommands = [{ argv: ['bun', 'run', 'test'], unitTests: true }]
  expect(() => checkSuiteTestTimeoutArguments(localCommands, false)).not.toThrow()
  expect(() => checkSuiteTestTimeoutArguments(ciCommands, false)).toThrow(
    "local Bun unit-test command must keep Bun's default timeout",
  )
})

test('requires forwarded package scripts to be one bun test invocation', () => {
  expect(() => checkSingleBunTestScript('bun test', 'hub/web test')).not.toThrow()
  expect(() => checkSingleBunTestScript('bun test src', 'retrieval test')).not.toThrow()
  expect(() =>
    checkSingleBunTestScript('bun test && bun run --cwd ../ui test', 'hub/web test'),
  ).toThrow('hub/web test must be a single bun test invocation so CI timeout arguments reach it')
})
