import { expect, test } from 'bun:test'
import {
  architectureUndeclaredModules,
  countUndeclaredModules,
} from './architecture-undeclared-modules.ts'

const undeclared = 'orchestrator/src/route/route-budget.ts'

test('an undeclared source file fails, naming the file and the remedy', () => {
  const violations = architectureUndeclaredModules([undeclared], [], [])

  expect(violations).toHaveLength(1)
  expect(violations[0]).toContain(undeclared)
  expect(violations[0]).toContain('belongs to no manifest module')
  expect(violations[0]).toContain('scripts/architecture.ts')
})

test('a declared source file passes by exact location and by manifest glob', () => {
  expect(architectureUndeclaredModules([undeclared], [undeclared], [])).toEqual([])
  expect(architectureUndeclaredModules([undeclared], ['orchestrator/src/route/*.ts'], [])).toEqual(
    [],
  )
})

test('a baselined source file passes', () => {
  expect(architectureUndeclaredModules([undeclared], [], [undeclared])).toEqual([])
})

test('a baseline entry whose file is now declared fails until removed', () => {
  const violations = architectureUndeclaredModules([undeclared], [undeclared], [undeclared])

  expect(violations).toHaveLength(1)
  expect(violations[0]).toContain(undeclared)
  expect(violations[0]).toContain('now declared')
})

test('a baseline entry whose file is gone fails until removed', () => {
  const violations = architectureUndeclaredModules([], [], [undeclared])

  expect(violations).toHaveLength(1)
  expect(violations[0]).toContain(undeclared)
  expect(violations[0]).toContain('gone')
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
    ),
  ).toEqual([])
})

test('the undeclared count reports files that belong to no manifest module', () => {
  expect(countUndeclaredModules([undeclared, 'hub/src/attribute.ts'], [undeclared])).toBe(1)
})
