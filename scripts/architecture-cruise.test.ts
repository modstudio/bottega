import { expect, test } from 'bun:test'
import { architectureCruiseCoverageViolations } from './architecture-cruise.ts'

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
