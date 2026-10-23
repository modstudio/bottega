import { describe, expect, test } from 'bun:test'
import {
  decideFocusedTestPathFacts,
  decideFocusedTestRequest,
  decideFocusedTestWait,
  FOCUSED_TEST_MAX_PATHS,
  focusedTestInvocation,
  hasFocusedTestRunner,
  normalizeFocusedTestPaths,
  parseFocusedTestRequest,
  parseFocusedTestResult,
} from './focused-test-decision.ts'

describe('focused test decisions', () => {
  test('only a valid focused test declaration counts as a registered runner', () => {
    expect(hasFocusedTestRunner({ command: 'scripts/test-focused', args: [] })).toBeTrue()
    expect(hasFocusedTestRunner(null)).toBeFalse()
    expect(hasFocusedTestRunner({ command: '', args: [] })).toBeFalse()
  })

  test('starts, joins, returns, and caps waits without filesystem state', () => {
    const execution = { id: 'request-1', paths: ['tests/one.test.ts'] }
    expect(
      decideFocusedTestRequest({ execution: null, finished: false, resultPending: false }),
    ).toEqual({ action: 'start' })
    expect(decideFocusedTestRequest({ execution, finished: false, resultPending: true })).toEqual({
      action: 'join',
      execution,
    })
    expect(decideFocusedTestRequest({ execution, finished: true, resultPending: true })).toEqual({
      action: 'return',
      execution,
    })
    expect(decideFocusedTestRequest({ execution, finished: true, resultPending: false })).toEqual({
      action: 'start',
    })
    expect(
      decideFocusedTestWait({
        finished: false,
        waitElapsedMs: 10,
        paths: execution.paths,
        waitMs: 10,
      }),
    ).toEqual({
      wait: false,
      message:
        'Focused tests for "tests/one.test.ts" are still running. ' +
        'Call run_tests again to wait for and collect this same execution.',
    })
  })

  test('requires bounded project-relative non-option paths', () => {
    expect(normalizeFocusedTestPaths(['tests/one.test.ts', 'tests'])).toEqual([
      'tests/one.test.ts',
      'tests',
    ])
    expect(() => normalizeFocusedTestPaths(['/worktree/tests'])).toThrow(
      'focused test path "/worktree/tests" must be relative',
    )
    expect(() => normalizeFocusedTestPaths(['../outside'])).toThrow(
      'focused test path "../outside" contains a parent segment',
    )
    expect(() => normalizeFocusedTestPaths(['--filter'])).toThrow(
      'focused test path "--filter" must not start with',
    )
    expect(() => normalizeFocusedTestPaths([])).toThrow('at least one')
    expect(() =>
      normalizeFocusedTestPaths(Array.from({ length: FOCUSED_TEST_MAX_PATHS + 1 }, () => 'x')),
    ).toThrow(`at most ${FOCUSED_TEST_MAX_PATHS}`)
  })

  test('decides existence and canonical confinement from filesystem facts', () => {
    expect(
      decideFocusedTestPathFacts([
        {
          entry: 'tests/one.test.ts',
          normalized: 'tests/one.test.ts',
          resolvedRoot: '/tree',
          resolvedCandidate: '/tree/tests/one.test.ts',
          exists: true,
        },
      ]),
    ).toEqual(['tests/one.test.ts'])
    expect(() =>
      decideFocusedTestPathFacts([
        {
          entry: 'missing.test.ts',
          normalized: 'missing.test.ts',
          resolvedRoot: '/tree',
          resolvedCandidate: null,
          exists: false,
        },
      ]),
    ).toThrow('focused test path "missing.test.ts" does not exist')
    expect(() =>
      decideFocusedTestPathFacts([
        {
          entry: 'escape.test.ts',
          normalized: 'escape.test.ts',
          resolvedRoot: '/tree',
          resolvedCandidate: '/outside/escape.test.ts',
          exists: true,
        },
      ]),
    ).toThrow('focused test path "escape.test.ts" resolves outside the run worktree')
  })

  test('builds argv only from registered args followed by validated paths', () => {
    const invocation = focusedTestInvocation(
      { command: 'scripts/test-focused', args: ['--fixed', 'registered'] },
      ['tests/one.test.ts'],
      '/worktree',
    )
    expect(invocation).toEqual({
      command: '/worktree/scripts/test-focused',
      argv: ['--fixed', 'registered', 'tests/one.test.ts'],
    })
    expect(invocation.argv).not.toContain('--from-request')
    expect(
      focusedTestInvocation({ command: 'bun', args: ['test'] }, ['tests/one.test.ts'], '/worktree')
        .command,
    ).toBe('bun')
  })

  test('parses only the request and result transport shapes', () => {
    expect(
      parseFocusedTestRequest({
        id: 'request-1',
        paths: ['tests/one.test.ts'],
        args: ['injected'],
      }),
    ).toEqual({
      id: 'request-1',
      paths: ['tests/one.test.ts'],
    })
    expect(
      parseFocusedTestResult({
        exitCode: 0,
        timedOut: false,
        elapsedMs: 4,
        logName: 'focused-test-1.log',
        outputTail: 'ok',
      }),
    ).toEqual({
      exitCode: 0,
      timedOut: false,
      elapsedMs: 4,
      logName: 'focused-test-1.log',
      outputTail: 'ok',
    })
    expect(() => parseFocusedTestRequest({ id: 'request-1', paths: 'tests' })).toThrow(
      'array of strings',
    )
    expect(() =>
      parseFocusedTestResult({
        exitCode: 0,
        timedOut: false,
        elapsedMs: 4,
        logName: '../escape.log',
        outputTail: '',
      }),
    ).toThrow('logName is invalid')
  })
})
