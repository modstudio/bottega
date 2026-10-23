import { expect, test } from 'bun:test'
import { CHECK_LEGS, ROOT_TEST_FILES } from './check-plan.ts'
import {
  assertExemptionBaselineShrinks,
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

test('the hub data package is reached only by its own package leg', () => {
  const hub = CHECK_LEGS.find((leg) => leg.name === 'hub')!
  const data = CHECK_LEGS.find((leg) => leg.name === 'hub/data')!
  expect(hub.excludedTestDirectories).toContain('hub/data')
  expect(hub.suite.some(({ argv }) => argv.includes('data'))).toBe(false)
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
