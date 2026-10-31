import { expect, test } from 'bun:test'
import { ORCHESTRATOR_GATE_TEST_SELECTION } from '../orchestrator/test/gate-test-selection.ts'
import { categorizeFile } from '../shared/file-kind.ts'
import { CHECK_LEGS, CI_ONLY_SUITES, ROOT_TEST_FILES, suiteReachPatterns } from './check-plan.ts'
import {
  assertExemptionBaselineShrinks,
  ciOnlySuiteLegs,
  parseTestReachExemptions,
  testReach,
} from './check-test-reach.ts'

test('exports the root test manifest separately from the check runner', () => {
  expect(ROOT_TEST_FILES).toContain('scripts/check-test-reach.test.ts')
  expect(ROOT_TEST_FILES.every((file) => !file.startsWith('shared/'))).toBe(true)
})

test('the shared leg uses a directory-anchored selector that collects only shared tests', () => {
  const shared = CHECK_LEGS.find((leg) => leg.name === 'shared')!
  expect(shared.suite).toEqual([{ argv: ['bun', 'test', './shared'], unitTests: true }])
  expect(shared.testDirectories).toEqual(['shared'])
})

test('the Python hook leg runs unittest discovery over its declared reach', () => {
  const hooks = CHECK_LEGS.find((leg) => leg.name === 'orchestrator/hooks')!
  expect(hooks).toMatchObject({
    directory: '.',
    ciJob: 'orchestrator-hooks',
    testDirectories: [],
    testPatterns: ['orchestrator/hooks/test_*.py'],
    typecheck: null,
    suite: [
      {
        argv: [
          'python3',
          '-m',
          'unittest',
          'discover',
          '-s',
          'orchestrator/hooks',
          '-p',
          'test_*.py',
        ],
        unitTests: true,
      },
    ],
  })
})

test('each CI-only suite derives its reach from the command it runs', () => {
  expect(ciOnlySuiteLegs().flatMap((leg) => leg.testPatterns)).toEqual([
    'orchestrator/hooks/process_*.py',
  ])
  expect(
    suiteReachPatterns([
      'python3',
      '-m',
      'unittest',
      'discover',
      '-s',
      'orchestrator/hooks',
      '-p',
      'process_heartbeat_*.py',
    ]),
  ).toEqual(['orchestrator/hooks/process_heartbeat_*.py'])
  expect(() =>
    suiteReachPatterns(['python3', '-m', 'unittest', 'discover', '-s', 'orchestrator/hooks']),
  ).toThrow('must carry -s <dir> and -p <pattern>')
})

test('every file a CI-only suite collects is classified as a test', () => {
  for (const pattern of CI_ONLY_SUITES.flatMap((suite) => suite.testPatterns)) {
    expect(categorizeFile(pattern.replaceAll('*', 'example'))).toBe('test')
  }
})

test('the orchestrator gate selectors are anchored and cover every declared exclusion', () => {
  const orchestrator = CHECK_LEGS.find((leg) => leg.name === 'orchestrator')!
  const selections = ORCHESTRATOR_GATE_TEST_SELECTION.directories

  expect(selections.every(({ selector }) => selector.startsWith('./'))).toBe(true)
  for (const reach of orchestrator.testDirectories) {
    expect(
      selections.filter(({ selector }) => `orchestrator/${selector.slice(2)}` === reach),
    ).toHaveLength(1)
  }

  for (const reachDirectory of orchestrator.excludedTestDirectories) {
    const relativeDirectory = reachDirectory.replace(/^orchestrator\//, '')
    expect(
      ORCHESTRATOR_GATE_TEST_SELECTION.exclusions.filter(
        (exclusion) =>
          'reachDirectory' in exclusion &&
          exclusion.reachDirectory === reachDirectory &&
          exclusion.ignore === `${relativeDirectory}/**`,
      ),
    ).toHaveLength(1)
  }
  for (const reachPattern of orchestrator.excludedTestPatterns) {
    const relativePattern = reachPattern.replace(/^orchestrator\//, '')
    expect(
      ORCHESTRATOR_GATE_TEST_SELECTION.exclusions.filter(
        (exclusion) =>
          'reachPattern' in exclusion &&
          exclusion.reachPattern === reachPattern &&
          exclusion.ignore === relativePattern,
      ),
    ).toHaveLength(1)
  }
})

test('the hub data package is reached only by its own package leg', () => {
  const hub = CHECK_LEGS.find((leg) => leg.name === 'hub')!
  const data = CHECK_LEGS.find((leg) => leg.name === 'hub/data')!
  expect(hub.excludedTestDirectories).toContain('hub/data')
  expect(hub.suite.some(({ argv }) => (argv as readonly string[]).includes('data'))).toBe(false)
  expect(data).toMatchObject({
    directory: 'hub/data',
    ciJob: 'hub-data',
    testDirectories: ['hub/data'],
    typecheck: ['bun', 'run', 'typecheck'],
    suite: [{ argv: ['bun', 'run', 'test'], unitTests: true }],
  })
})

test('source-filtered legs claim only the source directories their suites collect', () => {
  expect(CHECK_LEGS.find((leg) => leg.name === 'hub/deploy/site')!.testDirectories).toEqual([
    'hub/deploy/site/src',
  ])
  expect(CHECK_LEGS.find((leg) => leg.name === 'retrieval')!.testDirectories).toEqual([
    'retrieval/src',
  ])
})

test('reports tracked tests outside a leg or root batch unless exempted', () => {
  expect(
    testReach({
      tracked: [
        'orchestrator/src/reached.test.ts',
        'scripts/root.test.ts',
        'scripts/unreached.test.ts',
        'orchestrator/hooks/test_guard.py',
        'README.md',
      ],
      rootTests: ['scripts/root.test.ts'],
      legs: [
        {
          testDirectories: ['orchestrator/src'],
          testPatterns: [],
          excludedTestDirectories: [],
          excludedTestPatterns: [],
        },
      ],
      exemptions: [
        { file: 'orchestrator/hooks/test_guard.py', reason: 'shell hook suite pending' },
      ],
    }),
  ).toEqual({
    unreached: ['orchestrator/hooks/test_guard.py', 'scripts/unreached.test.ts'],
    unexempted: ['scripts/unreached.test.ts'],
    staleExemptions: [],
  })
})

test('a CI-only suite counts its own process file as reached and no other process file as a test', () => {
  const tracked = [
    'orchestrator/hooks/process_heartbeat_shell.py',
    'orchestrator/hooks/nested/process_extra.py',
    'scripts/process_monitor.py',
  ]
  expect(
    testReach({
      tracked,
      rootTests: [],
      legs: [...CHECK_LEGS, ...ciOnlySuiteLegs()],
      exemptions: [],
    }),
  ).toEqual({ unreached: [], unexempted: [], staleExemptions: [] })
  expect(testReach({ tracked, rootTests: [], legs: CHECK_LEGS, exemptions: [] })).toEqual({
    unreached: ['orchestrator/hooks/process_heartbeat_shell.py'],
    unexempted: ['orchestrator/hooks/process_heartbeat_shell.py'],
    staleExemptions: [],
  })
})

test('a nested Python hook test outside unittest discovery remains unreached', () => {
  expect(
    testReach({
      tracked: ['orchestrator/hooks/test_top_level.py', 'orchestrator/hooks/nested/test_x.py'],
      rootTests: [],
      legs: CHECK_LEGS,
      exemptions: [],
    }),
  ).toEqual({
    unreached: ['orchestrator/hooks/nested/test_x.py'],
    unexempted: ['orchestrator/hooks/nested/test_x.py'],
    staleExemptions: [],
  })
})

test('new tests in the skipped Postgres suite remain unreached without exemptions', () => {
  expect(
    testReach({
      tracked: [
        'orchestrator/src/postgres/new-policy.test.ts',
        'orchestrator/src/record/new-policy-postgres.test.ts',
      ],
      rootTests: [],
      legs: CHECK_LEGS,
      exemptions: [],
    }),
  ).toEqual({
    unreached: [
      'orchestrator/src/postgres/new-policy.test.ts',
      'orchestrator/src/record/new-policy-postgres.test.ts',
    ],
    unexempted: [
      'orchestrator/src/postgres/new-policy.test.ts',
      'orchestrator/src/record/new-policy-postgres.test.ts',
    ],
    staleExemptions: [],
  })
})

test('requires a reason and rejects duplicate exemptions', () => {
  expect(() => parseTestReachExemptions('[{"file":"scripts/a.test.ts","reason":""}]')).toThrow(
    'non-empty reason',
  )
  expect(() =>
    parseTestReachExemptions(
      '[{"file":"scripts/a.test.ts","reason":"pending"},{"file":"scripts/a.test.ts","reason":"pending"}]',
    ),
  ).toThrow('duplicate test-reach exemption')
})

test('the exemption baseline may only shrink after initialization', () => {
  const existing = [{ file: 'scripts/a.test.ts', reason: 'pending' }]
  expect(() => assertExemptionBaselineShrinks(existing, null)).not.toThrow()
  expect(() => assertExemptionBaselineShrinks([], existing)).not.toThrow()
  expect(() =>
    assertExemptionBaselineShrinks(
      [...existing, { file: 'scripts/b.test.ts', reason: 'pending' }],
      existing,
    ),
  ).toThrow('may only shrink')
})
