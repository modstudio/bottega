import { describe, expect, test } from 'bun:test'
import {
  HUNG_SUITE_TIMEOUT_MS,
  SUITE_RUNTIME_BUDGET_MS,
  decideRuntimeBudget,
} from './check-runtime'

describe('suite runtime budget', () => {
  test.each([
    { elapsedMs: 121_000, ci: false, verdict: 'over-informational' },
    { elapsedMs: 121_000, ci: true, verdict: 'over-fatal' },
    { elapsedMs: 119_000, ci: true, verdict: 'within' },
    { elapsedMs: 119_000, ci: false, verdict: 'within' },
  ] as const)('$verdict when elapsed=$elapsedMs and ci=$ci', ({ elapsedMs, ci, verdict }) => {
    expect(
      decideRuntimeBudget({
        elapsedMs,
        budgetMs: SUITE_RUNTIME_BUDGET_MS,
        ci,
      }),
    ).toBe(verdict)
  })

  test('hung-suite timeout remains separate from the regression budget', () => {
    expect(HUNG_SUITE_TIMEOUT_MS).toBeGreaterThan(SUITE_RUNTIME_BUDGET_MS)
  })
})
