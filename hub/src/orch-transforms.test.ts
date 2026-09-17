import { describe, expect, test } from 'bun:test'
import { OrchStateSchema } from '../../shared/orch-contract.ts'
import { routingViewData } from './orch-transforms.ts'

describe('routing snapshot transform', () => {
  test('local and hosted paths produce identical output from the same payloads', () => {
    const state = OrchStateSchema.parse({
      live: [],
      stale: 2,
      matrix: [],
      guide: [],
      health: [],
      totals: { runs: 4, failed: 1, stale_n: 2, toks: 100, scored: 3 },
      unscored: 1,
      spawns: [],
      agents: [],
      byRepo: [],
    })
    const blockers = { days: 14, blockers: [] }
    expect(routingViewData(state, blockers)).toEqual({
      guide: [],
      matrix: [],
      health: [],
      blockerDays: 14,
      blockers: [],
      agents: [],
      spawns: [],
      byRepo: [],
      totals: state.totals,
      unscored: 1,
      stale: 2,
    })
  })
})
