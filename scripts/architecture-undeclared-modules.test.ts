import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  architectureUndeclaredModules,
  countUndeclaredModules,
  parseUndeclaredModulesBaseline,
} from './architecture-undeclared-modules.ts'
import { undeclaredModulesBaseline } from './quality/undeclared-modules-baseline.ts'

const undeclared = 'orchestrator/src/route/route-budget.ts'

test('an undeclared source file fails, naming the file and the remedy', () => {
  const violations = architectureUndeclaredModules([undeclared], [], [], null)

  expect(violations).toHaveLength(1)
  expect(violations[0]).toContain(undeclared)
  expect(violations[0]).toContain('belongs to no manifest module')
  expect(violations[0]).toContain('scripts/architecture.ts')
})

test('a declared source file passes by exact location', () => {
  expect(architectureUndeclaredModules([undeclared], [undeclared], [], null)).toEqual([])
})

test('a baselined source file passes', () => {
  expect(architectureUndeclaredModules([undeclared], [], [undeclared], null)).toEqual([])
})

test('a baseline entry whose file is now declared fails until removed', () => {
  const violations = architectureUndeclaredModules([undeclared], [undeclared], [undeclared], null)

  expect(violations).toHaveLength(1)
  expect(violations[0]).toContain(undeclared)
  expect(violations[0]).toContain('now declared')
})

test('a baseline entry whose file is gone fails until removed', () => {
  const violations = architectureUndeclaredModules([], [], [undeclared], null)

  expect(violations).toHaveLength(1)
  expect(violations[0]).toContain(undeclared)
  expect(violations[0]).toContain('gone')
})

test('a baseline entry the base revision did not freeze fails until removed', () => {
  const violations = architectureUndeclaredModules([undeclared], [], [undeclared], [])

  expect(violations).toHaveLength(1)
  expect(violations[0]).toContain(undeclared)
  expect(violations[0]).toContain('may only shrink')
})

test('a baseline that keeps or drops frozen entries passes', () => {
  expect(architectureUndeclaredModules([undeclared], [], [undeclared], [undeclared])).toEqual([])
  expect(architectureUndeclaredModules([], [], [], [undeclared])).toEqual([])
})

test('test files and test folders are ignored', () => {
  expect(
    architectureUndeclaredModules(
      [
        'orchestrator/src/route/route-budget.test.ts',
        'orchestrator/src/run/test/run-fixture-helper.ts',
        'hub/src/attribute.spec.tsx',
      ],
      [],
      [],
      null,
    ),
  ).toEqual([])
})

test('the undeclared count reports files that belong to no manifest module', () => {
  expect(countUndeclaredModules([undeclared, 'hub/src/attribute.ts'], [undeclared])).toBe(1)
})

test('the baseline module parses to the frozen list the check reads', () => {
  const text = readFileSync(
    new URL('./quality/undeclared-modules-baseline.ts', import.meta.url),
    'utf8',
  )

  expect(parseUndeclaredModulesBaseline(text)).toEqual([...undeclaredModulesBaseline])
})

test('text that is not the frozen list refuses instead of reading every entry as new', () => {
  expect(() =>
    parseUndeclaredModulesBaseline("export const other = ['hub/src/attribute.ts']\n"),
  ).toThrow('not the frozen list module')
})
