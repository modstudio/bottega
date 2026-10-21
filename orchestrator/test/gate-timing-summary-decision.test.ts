import { describe, expect, test } from 'bun:test'
import { decideTimingGrowthPublication } from './gate-timing-summary-decision.ts'

describe('timing growth publication decision', () => {
  test('a whole-suite run without an overrun compares its growth locally and in CI', () => {
    expect(
      decideTimingGrowthPublication({ growth: 'compare', longPoleCount: 0, ci: false }),
    ).toEqual({
      kind: 'compare',
      longPolesPassed: true,
      reportOnly: false,
    })
    expect(
      decideTimingGrowthPublication({ growth: 'compare', longPoleCount: 0, ci: true }),
    ).toEqual({ kind: 'compare', longPolesPassed: true, reportOnly: false })
  })

  test('a local long-pole overrun blocks', () => {
    expect(
      decideTimingGrowthPublication({ growth: 'skip-sharded', longPoleCount: 1, ci: false }),
    ).toEqual({
      kind: 'finish-sharded',
      passed: false,
      reportOnly: false,
    })
    expect(
      decideTimingGrowthPublication({ growth: 'compare', longPoleCount: 1, ci: false }),
    ).toEqual({ kind: 'compare', longPolesPassed: false, reportOnly: false })
  })

  test('a CI long-pole overrun reports and passes', () => {
    expect(
      decideTimingGrowthPublication({ growth: 'skip-sharded', longPoleCount: 1, ci: true }),
    ).toEqual({
      kind: 'finish-sharded',
      passed: true,
      reportOnly: true,
    })
    expect(
      decideTimingGrowthPublication({ growth: 'compare', longPoleCount: 1, ci: true }),
    ).toEqual({ kind: 'compare', longPolesPassed: true, reportOnly: true })
  })
})
