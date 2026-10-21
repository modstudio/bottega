import { expect, test } from 'bun:test'
import {
  type ArchitectureViolationEdge,
  architectureViolationRatchet,
} from './architecture-violation-baseline.ts'

const baselined: ArchitectureViolationEdge = {
  rule: 'no-new-orchestrator-cycles',
  from: 'orchestrator/src/transport/transport-acp-usage.ts',
  to: 'orchestrator/src/transport/transport-acp.ts',
}

test('architecture violation ratchet reports a new violation', () => {
  const added = {
    rule: 'import-orchestrator-boundary',
    from: 'orchestrator/src/run.ts',
    to: 'hub/src/note.ts',
  }

  expect(architectureViolationRatchet([baselined, added])).toEqual({
    newViolations: [added],
    fixedBaseline: [],
  })
})

test('architecture violation ratchet accepts a baselined violation', () => {
  expect(architectureViolationRatchet([baselined])).toEqual({
    newViolations: [],
    fixedBaseline: [],
  })
})

test('architecture violation ratchet reports a fixed baseline for removal', () => {
  const result = architectureViolationRatchet([])

  expect(result.newViolations).toEqual([])
  expect(result.fixedBaseline).toHaveLength(1)
  expect(result.fixedBaseline[0]).toMatchObject(baselined)
  expect(result.fixedBaseline[0]?.reason).toBeTruthy()
})
