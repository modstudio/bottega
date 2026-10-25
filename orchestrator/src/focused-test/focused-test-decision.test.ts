import { describe, expect, test } from 'bun:test'
import {
  decideFocusedTestEligibility,
  decideFocusedTestPathFacts,
  decideFocusedTestRequest,
  decideFocusedTestSelection,
  decideFocusedTestWait,
  FOCUSED_TEST_MAX_PATHS,
  focusedTestInvocation,
  hasFocusedTestRunner,
  normalizeAffectedTestPaths,
  normalizeFocusedTestPaths,
  parseAffectedSelectorOutput,
  parseFocusedTestRequest,
  parseFocusedTestResult,
  validateFocusedTestDeclaration,
} from './focused-test-decision.ts'

describe('focused test decisions', () => {
  test('only a valid focused test declaration counts as a registered runner', () => {
    expect(hasFocusedTestRunner({ command: 'scripts/test-focused', args: [] })).toBeTrue()
    expect(hasFocusedTestRunner(null)).toBeFalse()
    expect(hasFocusedTestRunner({ command: '', args: [] })).toBeFalse()
  })

  test('starts, joins, returns, and caps waits without filesystem state', () => {
    const execution = { id: 'request-1', paths: ['tests/one.test.ts'], affected: false }
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
      affected: false,
    })
    expect(
      parseFocusedTestRequest({ id: 'request-1', paths: [], affected: true }),
    ).toEqual({ id: 'request-1', paths: [], affected: true })
    expect(() =>
      parseFocusedTestRequest({ id: 'request-1', paths: [], affected: 'yes' }),
    ).toThrow('affected is invalid')
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

describe('affected focused test selections', () => {
  const selectorPaths = (count: number) =>
    Array.from({ length: count }, (_, index) => `orchestrator/src/module-${index}.test.ts`)

  test('a declaration carries an optional affected selector validated like the runner', () => {
    expect(
      validateFocusedTestDeclaration({
        command: 'scripts/test-focused.ts',
        args: [],
        affected: { command: 'scripts/affected-tests.ts', args: [] },
      }),
    ).toEqual({
      runner: { command: 'scripts/test-focused.ts', args: [] },
      selector: { command: 'scripts/affected-tests.ts', args: [] },
      problems: [],
    })
    expect(validateFocusedTestDeclaration({ command: 'runner', args: [] }).selector).toBeNull()
    expect(
      validateFocusedTestDeclaration({
        command: 'runner',
        args: [],
        affected: { command: '', args: ['ok', 1] },
      }).problems,
    ).toEqual([
      'focusedTests.affected.command must be a non-empty string',
      'focusedTests.affected.args must be an array of strings',
    ])
    expect(validateFocusedTestDeclaration({ command: 'runner', args: [], affected: 'yes' }).problems)
      .toEqual(['focusedTests.affected must be an object'])
  })

  test('asking for affected tests refuses when the project declares no selector', () => {
    const eligibility = (affected: boolean, selector: boolean) =>
      decideFocusedTestEligibility({
        authenticated: true,
        writer: true,
        runner: { command: 'runner', args: [] },
        selector: selector ? { command: 'selector', args: [] } : null,
        affected,
      })
    expect(eligibility(false, false)).toEqual({ eligible: true })
    expect(eligibility(true, true)).toEqual({ eligible: true })
    expect(eligibility(true, false)).toEqual({
      eligible: false,
      message: expect.stringContaining('focusedTests.affected'),
    })
  })

  test('a selector selection larger than the worker bound still runs', () => {
    const selection = decideFocusedTestSelection({
      affected: true,
      requestedPaths: [],
      selector: { kind: 'printed', stdout: selectorPaths(70).join('\n') },
    })
    expect(selection.kind).toBe('run')
    expect(selection.kind === 'run' ? selection.paths : []).toHaveLength(70)
    expect(normalizeAffectedTestPaths(selectorPaths(FOCUSED_TEST_MAX_PATHS + 1))).toHaveLength(
      FOCUSED_TEST_MAX_PATHS + 1,
    )
    expect(() => normalizeFocusedTestPaths(selectorPaths(FOCUSED_TEST_MAX_PATHS + 1))).toThrow(
      `at most ${FOCUSED_TEST_MAX_PATHS}`,
    )
  })

  test('the worker bound still refuses a call that passes more paths than it may', () => {
    const selection = decideFocusedTestSelection({
      affected: true,
      requestedPaths: selectorPaths(FOCUSED_TEST_MAX_PATHS + 1),
      selector: { kind: 'printed', stdout: 'orchestrator/src/one.test.ts' },
    })
    expect(selection).toEqual({
      kind: 'refuse',
      message: `paths may contain at most ${FOCUSED_TEST_MAX_PATHS} entries`,
    })
  })

  test('the union keeps the worker paths first and every path once', () => {
    const selection = decideFocusedTestSelection({
      affected: true,
      requestedPaths: ['orchestrator/src/one.test.ts', 'orchestrator/src/two.test.ts'],
      selector: {
        kind: 'printed',
        stdout: 'orchestrator/src/two.test.ts\norchestrator/src/three.test.ts\n\n',
      },
    })
    expect(selection).toEqual({
      kind: 'run',
      paths: [
        'orchestrator/src/one.test.ts',
        'orchestrator/src/two.test.ts',
        'orchestrator/src/three.test.ts',
      ],
      note: 'focusedTests.affected selected 2 test paths; running 3 paths in total.',
    })
  })

  test('an empty selection is a completed result, and a broken selector is not', () => {
    expect(
      decideFocusedTestSelection({
        affected: true,
        requestedPaths: [],
        selector: { kind: 'printed', stdout: '\n' },
      }),
    ).toEqual({ kind: 'none', message: expect.stringContaining('nothing was affected') })
    expect(
      decideFocusedTestSelection({
        affected: true,
        requestedPaths: [],
        selector: { kind: 'failed', exitCode: 3, timedOut: false, overflowed: false, stderrTail: 'no git\n' },
      }),
    ).toEqual({
      kind: 'refuse',
      message: expect.stringContaining('exited 3; its stderr tail:\nno git'),
    })
    expect(
      decideFocusedTestSelection({ affected: true, requestedPaths: [], selector: { kind: 'no-base' } }),
    ).toEqual({ kind: 'refuse', message: expect.stringContaining('records no base commit') })
  })

  test('paths a worker did not bound still have to be project-relative', () => {
    expect(parseAffectedSelectorOutput('/worktree/tests/one.test.ts\n')).toEqual({
      kind: 'refuse',
      message: expect.stringContaining('cannot read'),
    })
    expect(parseAffectedSelectorOutput('../outside.test.ts')).toEqual({
      kind: 'refuse',
      message: expect.stringContaining('parent segment'),
    })
  })

  test('a call that names no paths at all is still refused when it asks for no selection', () => {
    expect(decideFocusedTestSelection({ affected: false, requestedPaths: [] })).toEqual({
      kind: 'refuse',
      message: 'paths must contain at least one project-relative path',
    })
  })
})
