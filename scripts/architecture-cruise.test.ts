import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  architectureCruiseCoverageViolations,
  dependencyCruiserNodeVersionRefusal,
  NON_TYPESCRIPT_TEST_DEPENDENCIES,
} from './architecture-cruise.ts'

test('every non-TypeScript test dependency exists in the tree', () => {
  for (const tests of Object.values(NON_TYPESCRIPT_TEST_DEPENDENCIES)) {
    for (const path of tests) {
      expect(existsSync(new URL(`../${path}`, import.meta.url)), `${path} must exist`).toBeTrue()
    }
  }
})

test('dependency-cruiser Node version guard accepts the minimum and refuses older Node', () => {
  expect(dependencyCruiserNodeVersionRefusal('v24.0.0\n')).toBeUndefined()
  expect(dependencyCruiserNodeVersionRefusal('v26.12.0\n')).toBeUndefined()
  expect(dependencyCruiserNodeVersionRefusal('v22.23.0\n')).toBe(
    'dependency-cruiser found Node v22.23.0; install Node 24 or later, or set it up in CI',
  )
})

test('architecture cruise coverage names manifest modules absent from the cruise', () => {
  const violations = architectureCruiseCoverageViolations({
    moduleSources: ['orchestrator/src/run.ts', 'hub/src/unrelated.ts'],
    manifestSources: ['orchestrator/src/run.ts', 'orchestrator/src/missing.ts'],
    roots: ['orchestrator', 'hub'],
  })

  expect(violations).toHaveLength(1)
  expect(violations[0]).toContain('1 manifest module')
  expect(violations[0]).toContain('orchestrator/src/missing.ts')
})

test('architecture cruise coverage names roots that contributed no modules', () => {
  const violations = architectureCruiseCoverageViolations({
    moduleSources: ['orchestrator/src/run.ts'],
    manifestSources: ['orchestrator/src/run.ts'],
    roots: ['orchestrator', 'hub'],
  })

  expect(violations).toHaveLength(1)
  expect(violations[0]).toContain('hub')
  expect(violations[0]).toContain('zero modules')
})
