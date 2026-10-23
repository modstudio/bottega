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
