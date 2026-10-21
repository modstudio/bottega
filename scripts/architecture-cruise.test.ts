import { expect, test } from 'bun:test'
import { architectureCruiseCoverageViolations } from './architecture-cruise.ts'

test('architecture cruise coverage refuses fewer cruised modules than manifest modules', () => {
  expect(
    architectureCruiseCoverageViolations({
      moduleSources: ['orchestrator/src/run.ts'],
      manifestCount: 2,
      roots: ['orchestrator'],
    }),
  ).toEqual(['dependency-cruiser cruised 1 modules, fewer than 2 manifest modules'])
})
