import { describe, expect, test } from 'bun:test'
import { decideGateOutcome } from './check-outcome'

describe('gate outcome', () => {
  test('lists failed steps in the given order and exits 1', () => {
    expect(
      decideGateOutcome([
        { name: 'hub', exitCode: 1 },
        { name: 'orchestrator', exitCode: 0 },
        { name: 'check-architecture.ts', exitCode: 1 },
        { name: 'check-file-ceiling.ts', exitCode: 0 },
        { name: 'check-cognitive-ceiling.ts', exitCode: 2 },
      ]),
    ).toEqual({
      failures: ['hub', 'check-architecture.ts', 'check-cognitive-ceiling.ts'],
      exitCode: 1,
    })
  })

  test('exits 0 and lists nothing when every step passed', () => {
    expect(
      decideGateOutcome([
        { name: 'hub', exitCode: 0 },
        { name: 'check-architecture.ts', exitCode: 0 },
      ]),
    ).toEqual({ failures: [], exitCode: 0 })
  })
})
