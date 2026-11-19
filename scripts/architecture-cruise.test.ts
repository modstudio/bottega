import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  architectureCruiseCoverageViolations,
  dependencyCruiserNodeVersionRefusal,
  NON_TYPESCRIPT_TEST_DEPENDENCIES,
} from './architecture-cruise.ts'
import {
  identityReferenceGuardViolations,
  identityReferenceViolationCount,
} from './architecture-identity-reference.ts'

test('identity reference guard rejects an interpolated number-column lookup outside identity', () => {
  const added = identityReferenceViolationCount(
    '`SELECT requested.record_id WHERE $' +
      '{clause} AND requested.NuMbEr=? OR number IN (?) ON a.number=b.number`',
    'orchestrator/src/run/new.ts',
  )
  expect(identityReferenceGuardViolations({ 'orchestrator/src/run/new.ts': added }, {})).toEqual([
    'orchestrator/src/run/new.ts: production identity bypass count grew from 0 to 2; resolve the reference through identity/',
  ])
})

test('identity reference guard rejects a tagged-template number-column lookup', () => {
  const added = identityReferenceViolationCount(
    'tx`SELECT id FROM note WHERE number=$' + '{n}`',
    'orchestrator/src/run/new.ts',
  )
  expect(identityReferenceGuardViolations({ 'orchestrator/src/run/new.ts': added }, {})).toEqual([
    'orchestrator/src/run/new.ts: production identity bypass count grew from 0 to 1; resolve the reference through identity/',
  ])
})

test('identity reference guard counts predicates but not assignments', () => {
  expect(identityReferenceViolationCount('UPDATE task SET number=excluded.number')).toBe(0)
  expect(identityReferenceViolationCount('UPDATE task SET changed=1, number=${n}')).toBe(0)
  expect(identityReferenceViolationCount('const number = row.number')).toBe(0)
  expect(identityReferenceViolationCount('label.number = row.number')).toBe(0)
  expect(identityReferenceViolationCount('SELECT id FROM task WHERE number=?')).toBe(1)
  expect(identityReferenceViolationCount('add((parameter) => `s.number=${parameter}::integer`)')).toBe(
    1,
  )
  expect(
    identityReferenceViolationCount('SELECT id FROM task WHERE project=? AND number IN (?)'),
  ).toBe(1)
})

test('identity reference guard rejects a question-number helper call outside identity', () => {
  const added = identityReferenceViolationCount(
    'await questionByProjectNumber(database, number, projectId)',
    'orchestrator/src/run/new.ts',
  )
  expect(identityReferenceGuardViolations({ 'orchestrator/src/run/new.ts': added }, {})).toEqual([
    'orchestrator/src/run/new.ts: production identity bypass count grew from 0 to 1; resolve the reference through identity/',
  ])
})

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
