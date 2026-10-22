import { expect, test } from 'bun:test'
import { architectureViolationRatchet } from './architecture-violation-baseline.ts'

test('architecture violation ratchet reports a new violation', () => {
  const added = {
    rule: 'import-orchestrator-boundary',
    from: 'orchestrator/src/run.ts',
    to: 'hub/src/note.ts',
  }

  expect(architectureViolationRatchet([added])).toEqual({
    newViolations: [added],
    fixedBaseline: [],
  })
})
