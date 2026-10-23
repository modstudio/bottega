import { expect, test } from 'bun:test'
import {
  assertExemptionBaselineShrinks,
  parseTestReachExemptions,
  rootTestFiles,
  testReach,
} from './check-test-reach.ts'

test('finds root tests only inside the explicit root batch', () => {
  const source = `
const elsewhere = ['./outside.test.ts']
const rootTests = ['bun', 'test', './scripts/inside.test.ts', './hooks/test_guard.py']
]

const selected = new Set()
`
  expect(rootTestFiles(source)).toEqual(['hooks/test_guard.py', 'scripts/inside.test.ts'])
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
      testDirectories: ['orchestrator/src'],
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
