import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideFocusedTestEligibility,
  decideFocusedTestRequest,
  FOCUSED_TEST_MAX_PATHS,
  focusedTestInvocation,
  parseFocusedTestRequest,
  parseFocusedTestResult,
  validateFocusedTestPaths,
} from './focused-test-decision.ts'

let roots: string[] = []
const directory = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), name))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('focused test decisions', () => {
  test('confines existing files and directories to the real worktree', () => {
    const tree = directory('focused-tree-')
    mkdirSync(join(tree, 'tests'))
    writeFileSync(join(tree, 'tests', 'one.test.ts'), '')
    expect(validateFocusedTestPaths(['tests/one.test.ts', 'tests'], tree)).toEqual([
      'tests/one.test.ts',
      'tests',
    ])
    expect(() => validateFocusedTestPaths([join(tree, 'tests')], tree)).toThrow(
      `focused test path ${JSON.stringify(join(tree, 'tests'))} must be relative`,
    )
    expect(() => validateFocusedTestPaths(['../outside'], tree)).toThrow(
      'focused test path "../outside" contains a parent segment',
    )
    expect(() => validateFocusedTestPaths(['missing.test.ts'], tree)).toThrow(
      'focused test path "missing.test.ts" does not exist',
    )
  })

  test('rejects a symlink escape', () => {
    const tree = directory('focused-tree-')
    const outside = directory('focused-outside-')
    writeFileSync(join(outside, 'escape.test.ts'), '')
    symlinkSync(join(outside, 'escape.test.ts'), join(tree, 'escape.test.ts'))
    expect(() => validateFocusedTestPaths(['escape.test.ts'], tree)).toThrow(
      'focused test path "escape.test.ts" resolves outside the run worktree',
    )
  })

  test('requires a bounded non-empty path list', () => {
    const tree = directory('focused-tree-')
    expect(() => validateFocusedTestPaths([], tree)).toThrow('at least one')
    expect(() =>
      validateFocusedTestPaths(
        Array.from({ length: FOCUSED_TEST_MAX_PATHS + 1 }, () => 'x'),
        tree,
      ),
    ).toThrow(`at most ${FOCUSED_TEST_MAX_PATHS}`)
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
  })

  test('missing runner is an explicit no-op and concurrency is refused', () => {
    expect(
      decideFocusedTestEligibility({ authenticated: true, writer: true, runner: null }),
    ).toEqual({
      eligible: false,
      message: "This run's project has no registered focused test runner, so nothing was run.",
    })
    expect(decideFocusedTestRequest(true)).toBe(
      'A focused test run is already in flight for this run.',
    )
    expect(decideFocusedTestRequest(false)).toBeNull()
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
