import { expect, test } from 'bun:test'
import {
  architectureViolationBaseline,
  architectureViolationRatchet,
} from './architecture-violation-baseline.ts'

test('architecture violation ratchet reports a new violation', () => {
  const added = {
    rule: 'import-orchestrator-boundary',
    from: 'orchestrator/src/run.ts',
    to: 'hub/src/note.ts',
  }

  expect(architectureViolationRatchet([added]).newViolations).toEqual([added])
})

test('architecture violation ratchet reports fixed baseline entries', () => {
  const fixedBaseline = architectureViolationRatchet([]).fixedBaseline
  expect(fixedBaseline).toEqual([...architectureViolationBaseline])
  expect(fixedBaseline.length).toBeGreaterThan(0)
})

test('architecture violation ratchet accepts an existing baseline edge', () => {
  const existing = architectureViolationBaseline[0]
  if (!existing) throw new Error('architecture violation baseline must not be empty')
  expect(architectureViolationRatchet([existing])).toEqual({
    newViolations: [],
    fixedBaseline: architectureViolationBaseline.slice(1),
  })
})
