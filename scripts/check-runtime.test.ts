import { describe, expect, test } from 'bun:test'
import {
  decideRuntimeBudget,
  HUNG_SUITE_TIMEOUT_MS,
  SUITE_CPU_BUDGET_MS,
  SUITE_RUNTIME_BUDGET_MS,
} from './check-runtime'

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
