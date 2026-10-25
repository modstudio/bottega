import { expect, test } from 'bun:test'
import { ARCHITECTURE_CRUISE_ENTRIES } from './architecture-cruise.ts'
import {
  affectedSeedPattern,
  escapedSeedPath,
  seedPaths,
  selectedTestSources,
  typescriptCruiseEntries,
} from './affected-tests.ts'

test('every regular-expression metacharacter in a seed path is escaped', () => {
  expect(escapedSeedPath('orchestrator/src/a+b(c)[d].ts')).toBe(
    'orchestrator/src/a\\+b\\(c\\)\\[d\\]\\.ts',
  )
  expect(escapedSeedPath('a*b?.ts')).toBe('a\\*b\\?\\.ts')
  expect(escapedSeedPath('$^|{}\\')).toBe('\\$\\^\\|\\{\\}\\\\')
})

test('the seeded alternation matches its seeds and nothing they would otherwise reach', () => {
  const pattern = new RegExp(
    affectedSeedPattern([
      'orchestrator/src/a+b(c)[d].ts',
      'scripts/x.ts',
      'orchestrator/src/close/close-out.ts',
    ]),
  )
  expect(pattern.test('orchestrator/src/a+b(c)[d].ts')).toBeTrue()
  expect(pattern.test('scripts/x.ts')).toBeTrue()
  expect(pattern.test('orchestrator/src/close/close-out.ts')).toBeTrue()
  // An unescaped `+` would match one or more `a`; an unescaped `.` any character; a bare `(`
  // under `[...]` a character class of its own — and a bare bracket would not even compile.
  expect(pattern.test('orchestrator/src/aaab(c)[d].ts')).toBeFalse()
  expect(pattern.test('orchestrator/src/axb(c)[d].ts')).toBeFalse()
  expect(pattern.test('orchestrator/src/a+b(c)[e].ts')).toBeFalse()
  expect(pattern.test('orchestrator/src/close/close-outXts')).toBeFalse()
  expect(pattern.test('orchestrator/src/close/close-out.ts.bak')).toBeFalse()
})

test('only changed and untracked TypeScript sources become seeds', () => {
  expect(
    seedPaths([
      'orchestrator/src/close/close-out.ts',
      'orchestrator/src/close/close-out.ts',
      'hub/web/src/App.tsx',
      '.agents/contexts/hub.md',
      'scripts/affected-tests.test.ts',
      'scripts/test-focused.ts',
      'ops/thing.sh',
      '',
    ]),
  ).toEqual([
    'hub/web/src/App.tsx',
    'orchestrator/src/close/close-out.ts',
    'scripts/affected-tests.test.ts',
    'scripts/test-focused.ts',
  ])
})

test('the cruise entries narrow to TypeScript sources and drop shell-only entries', () => {
  const entries = typescriptCruiseEntries(ARCHITECTURE_CRUISE_ENTRIES)
  expect(entries).toContain('orchestrator/{src,test,deploy,hooks,scripts}/**/*.{ts,tsx}')
  expect(entries).toContain('hub/{data,site,ui,util,views,web}/*.{ts,tsx}')
  expect(entries.every((entry) => entry.endsWith('.{ts,tsx}'))).toBeTrue()
  expect(entries).toHaveLength(
    ARCHITECTURE_CRUISE_ENTRIES.filter((entry) => entry.includes('{ts,tsx,')).length,
  )
})

test('a cruise selection names each test module once and no other module', () => {
  expect(
    selectedTestSources([
      { source: 'orchestrator/src/close/close-out.test.ts' },
      { source: 'orchestrator/src/close/close-out.ts' },
      { source: 'hub/web/src/App.test.tsx' },
      { source: 'orchestrator/src/close/close-out.test.ts' },
      { source: 'orchestrator/src/close/close-out.test.helper.ts' },
    ]),
  ).toEqual(['hub/web/src/App.test.tsx', 'orchestrator/src/close/close-out.test.ts'])
})
