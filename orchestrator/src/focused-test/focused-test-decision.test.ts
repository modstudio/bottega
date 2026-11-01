import { describe, expect, test } from 'bun:test'
import {
  affectedSelectorPathRefusal,
  decideAffectedSelection,
  decideFocusedTestEligibility,
  decideFocusedTestPathFacts,
  decideFocusedTestRequest,
  decideFocusedTestSelection,
  decideFocusedTestSelectorOutcome,
  decideFocusedTestWait,
  declaredFocusedTestCommands,
  FOCUSED_TEST_MAX_PATHS,
  FOCUSED_TEST_SELECTOR_OUTPUT_MAX_BYTES,
  focusedTestInvocation,
  formatFocusedTestRequestDecision,
  hasFocusedTestRunner,
  normalizeAffectedTestPaths,
  normalizeFocusedTestPaths,
  parseAffectedSelectorOutput,
  parseFocusedTestRequest,
  parseFocusedTestResult,
  splitFocusedTestPaths,
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

  test('a joining call reports the running execution declaration', () => {
    expect(
      formatFocusedTestRequestDecision(
        {
          action: 'join',
          execution: {
            id: 'request-1',
            paths: ['tests/mutation.test.ts'],
            affected: false,
            expect: 'fail',
          },
        },
        ['tests/ignored.test.ts'],
      ),
    ).toContain("The running execution declares expect: 'fail'.")
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
    ).toThrow(
      `at most ${FOCUSED_TEST_MAX_PATHS} entries; run run_check for the whole suite, or split the selection across run_tests calls`,
    )
  })

  test('decides existence and canonical confinement from filesystem facts', () => {
    expect(
      decideFocusedTestPathFacts([
        {
          path: 'tests/one.test.ts',
          resolvedRoot: '/tree',
          resolvedCandidate: '/tree/tests/one.test.ts',
          exists: true,
        },
      ]),
    ).toEqual(['tests/one.test.ts'])
    expect(() =>
      decideFocusedTestPathFacts([
        {
          path: 'missing.test.ts',
          resolvedRoot: '/tree',
          resolvedCandidate: null,
          exists: false,
        },
      ]),
    ).toThrow('focused test path "missing.test.ts" does not exist')
    expect(() =>
      decideFocusedTestPathFacts([
        {
          path: 'escape.test.ts',
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
      focusedTestInvocation(
        { command: 'bun', args: ['test'], exactPaths: true },
        ['tests/one.test.ts', 'tests/two.test.ts'],
        '/worktree',
      ).argv,
    ).toEqual(['test', './tests/one.test.ts', './tests/two.test.ts'])
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
    expect(parseFocusedTestRequest({ id: 'request-1', paths: [], affected: true })).toEqual({
      id: 'request-1',
      paths: [],
      affected: true,
    })
    expect(
      parseFocusedTestRequest({ id: 'request-1', paths: [], affected: false, expect: 'fail' }),
    ).toEqual({ id: 'request-1', paths: [], affected: false, expect: 'fail' })
    expect(() => parseFocusedTestRequest({ id: 'request-1', paths: [], affected: 'yes' })).toThrow(
      'affected is invalid',
    )
    expect(() => parseFocusedTestRequest({ id: 'request-1', paths: [], expect: 'pass' })).toThrow(
      'expect is invalid',
    )
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
      runners: [
        {
          command: 'scripts/test-focused.ts',
          args: [],
          affected: { command: 'scripts/affected-tests.ts', args: [] },
        },
      ],
      problems: [],
    })
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
    expect(
      validateFocusedTestDeclaration({ command: 'runner', args: [], affected: 'yes' }).problems,
    ).toEqual(['focusedTests.affected must be an object'])
  })

  test('validates and carries exact path declarations only on runners', () => {
    expect(
      validateFocusedTestDeclaration({ command: 'bun', args: ['test'], exactPaths: true }),
    ).toEqual({
      runners: [{ command: 'bun', args: ['test'], exactPaths: true }],
      problems: [],
    })
    expect(
      validateFocusedTestDeclaration({ command: 'bun', args: ['test'], exactPaths: 'yes' })
        .problems,
    ).toEqual(['focusedTests.exactPaths must be a boolean'])
    expect(
      validateFocusedTestDeclaration({
        runners: [{ command: 'bun', args: ['test'], patterns: ['**/*.test.ts'], exactPaths: true }],
      }),
    ).toEqual({
      runners: [{ command: 'bun', args: ['test'], patterns: ['**/*.test.ts'], exactPaths: true }],
      problems: [],
    })
    expect(
      validateFocusedTestDeclaration({
        runners: [
          { command: 'bun', args: ['test'], patterns: ['**/*.test.ts'], exactPaths: 'yes' },
        ],
      }).problems,
    ).toEqual(['focusedTests.runners[0].exactPaths must be a boolean'])
  })

  test('asking for affected tests refuses when the project declares no selector', () => {
    const eligibility = (affected: boolean, selector: boolean) =>
      decideFocusedTestEligibility({
        authenticated: true,
        writer: true,
        runners: [
          {
            command: 'runner',
            args: [],
            ...(selector ? { affected: { command: 'selector', args: [] } } : {}),
          },
        ],
        selectorProblem: null,
        affected,
      })
    expect(eligibility(false, false)).toEqual({ eligible: true })
    expect(eligibility(true, true)).toEqual({ eligible: true })
    expect(eligibility(true, false)).toEqual({
      eligible: false,
      message: expect.stringContaining('focusedTests.affected'),
    })
  })

  test('a malformed selector leaves the runner registered and names the selector key', () => {
    const settings = JSON.stringify({
      focusedTests: {
        command: 'scripts/test-focused.ts',
        args: [],
        affected: { command: '', args: [] },
      },
    })
    expect(declaredFocusedTestCommands(settings)).toEqual({
      runners: [{ command: 'scripts/test-focused.ts', args: [] }],
      selectorProblem: 'focusedTests.affected.command must be a non-empty string',
    })
    const commands = declaredFocusedTestCommands(settings)
    expect(
      decideFocusedTestEligibility({
        authenticated: true,
        writer: true,
        ...commands,
        affected: true,
      }),
    ).toEqual({
      eligible: false,
      message: expect.stringContaining('focusedTests.affected.command'),
    })
    expect(
      decideFocusedTestEligibility({
        authenticated: true,
        writer: true,
        ...commands,
        affected: false,
      }),
    ).toEqual({ eligible: true })
    expect(
      decideFocusedTestSelection({
        affected: true,
        requestedPaths: [],
        selector: {
          kind: 'ill-declared',
          problem: 'focusedTests.affected.command must be a non-empty string',
        },
      }),
    ).toEqual({ kind: 'refuse', message: expect.stringContaining('focusedTests.affected.command') })
    expect(declaredFocusedTestCommands('not json').runners).toEqual([])
    expect(
      declaredFocusedTestCommands(JSON.stringify({ focusedTests: { command: 'r', args: [] } })),
    ).toEqual({
      runners: [{ command: 'r', args: [] }],
      selectorProblem: null,
    })
  })

  test('splits paths between declared runners and keeps the legacy runner universal', () => {
    const declaration = validateFocusedTestDeclaration({
      runners: [
        { command: 'bun', args: ['test'], patterns: ['**/*.test.ts'] },
        { command: 'phpunit', args: [], patterns: ['**/*Test.php'] },
      ],
    })
    expect(declaration.problems).toEqual([])
    expect(
      splitFocusedTestPaths(declaration.runners, [
        'orchestrator/src/example.test.ts',
        'tests/Feature/ExampleTest.php',
      ]),
    ).toEqual({
      kind: 'groups',
      groups: [
        {
          runner: { command: 'bun', args: ['test'], patterns: ['**/*.test.ts'] },
          paths: ['orchestrator/src/example.test.ts'],
        },
        {
          runner: { command: 'phpunit', args: [], patterns: ['**/*Test.php'] },
          paths: ['tests/Feature/ExampleTest.php'],
        },
      ],
    })
    expect(
      splitFocusedTestPaths([{ command: 'bun', args: ['test'] }], ['any/path.spec.js']),
    ).toEqual({
      kind: 'groups',
      groups: [{ runner: { command: 'bun', args: ['test'] }, paths: ['any/path.spec.js'] }],
    })
  })

  test('multi-runner affected calls are eligible only when every runner has a selector', () => {
    const commands = declaredFocusedTestCommands(
      JSON.stringify({
        focusedTests: {
          runners: [
            {
              command: 'bun',
              args: ['test'],
              patterns: ['**/*.test.ts'],
              affected: { command: 'affected-bun', args: [] },
            },
            {
              command: 'phpunit',
              args: [],
              patterns: ['**/*Test.php'],
              affected: { command: 'affected-php', args: [] },
            },
          ],
        },
      }),
    )
    expect(
      decideFocusedTestEligibility({
        authenticated: true,
        writer: true,
        ...commands,
        affected: true,
      }),
    ).toEqual({ eligible: true })
  })

  test('unions and deduplicates every runner selector outcome and keeps the first refusal', () => {
    expect(
      decideAffectedSelection([
        { kind: 'printed', stdout: 'shared.test.ts\nbun.test.ts\n' },
        { kind: 'printed', stdout: 'shared.test.ts\nphp.test.php\n' },
      ]),
    ).toEqual({
      kind: 'paths',
      paths: ['shared.test.ts', 'bun.test.ts', 'php.test.php'],
    })
    expect(
      decideAffectedSelection([
        { kind: 'printed', stdout: '../outside.test.ts\n' },
        {
          kind: 'failed',
          exitCode: 2,
          timedOut: false,
          overflowed: false,
          stderrTail: 'later',
        },
      ]),
    ).toEqual({ kind: 'refuse', message: expect.stringContaining('parent segment') })
    expect(decideAffectedSelection([])).toEqual({ kind: 'none' })
  })

  test('refuses unmatched paths and overlapping runner declarations', () => {
    const runners = validateFocusedTestDeclaration({
      runners: [
        { command: 'one', args: [], patterns: ['src/**'] },
        { command: 'two', args: [], patterns: ['tests/**'] },
      ],
    }).runners
    expect(splitFocusedTestPaths(runners, ['docs/example.md'])).toEqual({
      kind: 'refuse',
      paths: ['docs/example.md'],
      message: expect.stringContaining('focusedTests.runners'),
    })
    expect(
      splitFocusedTestPaths(
        [
          { command: 'one', args: [], patterns: ['src/**'] },
          { command: 'two', args: [], patterns: ['**/*.ts'] },
        ],
        ['src/example.ts'],
      ),
    ).toEqual({
      kind: 'invalid-register',
      message: expect.stringContaining('focusedTests is invalid'),
    })
    expect(
      validateFocusedTestDeclaration({
        runners: [
          { command: 'one', args: [], patterns: ['**/*.ts'] },
          { command: 'two', args: [], patterns: ['**/*.ts'] },
        ],
      }).problems,
    ).toContain('focusedTests path pattern "**/*.ts" is claimed by two runners')
    expect(
      validateFocusedTestDeclaration({
        runners: [
          { command: 'one', args: [] },
          { command: 'two', args: [], patterns: ['**/*.ts'] },
        ],
      }).problems,
    ).toContain(
      'focusedTests.runners[0].patterns is required when focusedTests declares multiple runners',
    )
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
      message: `paths may contain at most ${FOCUSED_TEST_MAX_PATHS} entries; run run_check for the whole suite, or split the selection across run_tests calls`,
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
      selectorPaths: ['orchestrator/src/three.test.ts'],
      note: 'focusedTests.affected selected 2 test paths; running 3 paths in total.',
    })
  })

  test('a selector stopped for its own timeout or overflow is never reported as a closed run', () => {
    const stopped = (stopped: { timedOut: boolean; overflowed: boolean }) =>
      decideFocusedTestSelectorOutcome({
        cancelled: true,
        outcome: {
          kind: 'failed',
          exitCode: -1,
          timedOut: stopped.timedOut,
          overflowed: stopped.overflowed,
          stderrTail: 'selector noise\n',
        },
      })
    const timedOut = stopped({ timedOut: true, overflowed: false })
    expect(timedOut).toEqual({
      kind: 'failed',
      exitCode: -1,
      timedOut: true,
      overflowed: false,
      stderrTail: 'selector noise\n',
    })
    expect(
      decideFocusedTestSelection({ affected: true, requestedPaths: [], selector: timedOut }),
    ).toEqual({
      kind: 'refuse',
      message: expect.stringContaining(
        'the affected-test selector timed out; its stderr tail:\nselector noise',
      ),
    })
    const overflowed = stopped({ timedOut: false, overflowed: true })
    expect(
      decideFocusedTestSelection({ affected: true, requestedPaths: [], selector: overflowed }),
    ).toEqual({
      kind: 'refuse',
      message: expect.stringContaining(
        `printed more than ${FOCUSED_TEST_SELECTOR_OUTPUT_MAX_BYTES} bytes`,
      ),
    })
    // Only a selector that did not fail of its own accord reports the run's close, so no failure
    // message is ever replaced by the close reason.
    expect(
      decideFocusedTestSelectorOutcome({
        cancelled: true,
        outcome: { kind: 'printed', stdout: 'orchestrator/src/one.test.ts\n' },
      }),
    ).toEqual({ kind: 'closed' })
    expect(
      decideFocusedTestSelection({
        affected: true,
        requestedPaths: [],
        selector: { kind: 'closed' },
      }),
    ).toEqual({ kind: 'refuse', message: expect.stringContaining('supervising run closed') })
  })

  test('a path the selector printed that cannot run is refused against the selector', () => {
    expect(affectedSelectorPathRefusal('focused test path "gone.test.ts" does not exist')).toBe(
      'the affected-test selector (focusedTests.affected) printed a path run_tests cannot run: ' +
        'focused test path "gone.test.ts" does not exist',
    )
  })

  test('the union names the selector part of it and nothing the worker asked for', () => {
    const selection = decideFocusedTestSelection({
      affected: false,
      requestedPaths: ['orchestrator/src/one.test.ts'],
    })
    expect(selection.kind === 'run' ? selection.selectorPaths : ['unexpected']).toEqual([])
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
        selector: {
          kind: 'failed',
          exitCode: 3,
          timedOut: false,
          overflowed: false,
          stderrTail: 'no git\n',
        },
      }),
    ).toEqual({
      kind: 'refuse',
      message: expect.stringContaining('exited 3; its stderr tail:\nno git'),
    })
    expect(
      decideFocusedTestSelection({
        affected: true,
        requestedPaths: [],
        selector: { kind: 'no-base' },
      }),
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
