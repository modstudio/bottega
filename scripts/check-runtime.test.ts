import { describe, expect, test } from 'bun:test'
import {
  attributeCommandCpu,
  decideRuntimeBudget,
  HUNG_SUITE_TIMEOUT_MS,
  SUITE_CPU_BUDGET_MS,
  SUITE_RUNTIME_BUDGET_MS,
} from './check-runtime'

describe('command CPU attribution', () => {
  test('orders commands by total CPU and calculates their share', () => {
    expect(
      attributeCommandCpu([
        { name: 'middle', userMs: 20, systemMs: 10 },
        { name: 'largest', userMs: 45, systemMs: 15 },
        { name: 'smallest', userMs: 5, systemMs: 5 },
      ]),
    ).toEqual({
      totalMs: 100,
      commands: [
        { name: 'largest', cpuMs: 60, share: 0.6 },
        { name: 'middle', cpuMs: 30, share: 0.3 },
        { name: 'smallest', cpuMs: 10, share: 0.1 },
      ],
    })
  })
})

describe('suite runtime budget', () => {
  test('CPU time over budget under CI is fatal', () => {
    expect(
      decideRuntimeBudget({
        elapsedMs: SUITE_CPU_BUDGET_MS + 1,
        budgetMs: SUITE_CPU_BUDGET_MS,
        ci: true,
        measure: 'cpu',
      }),
    ).toBe('over-fatal')
  })

  test('wall clock over budget under CI is informational', () => {
    expect(
      decideRuntimeBudget({
        elapsedMs: SUITE_RUNTIME_BUDGET_MS + 1,
        budgetMs: SUITE_RUNTIME_BUDGET_MS,
        ci: true,
        measure: 'wall',
      }),
    ).toBe('over-informational')
  })

  test('hung-suite timeout remains separate from the regression budget', () => {
    expect(HUNG_SUITE_TIMEOUT_MS).toBeGreaterThan(SUITE_RUNTIME_BUDGET_MS)
  })
})
