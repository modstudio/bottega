import { describe, expect, test } from 'bun:test'
import { staticCheckPlan } from './check-plan.ts'

const STATIC_CHECKS = staticCheckPlan()

describe('worker static check plan', () => {
  test('gives every gate entry an explicit worker decision and a reason for every omission', () => {
    expect(STATIC_CHECKS.length).toBeGreaterThan(0)
    for (const check of STATIC_CHECKS) {
      expect(check.worker).toBeDefined()
      if (!check.worker.run) expect(check.worker.reason.trim()).not.toBe('')
    }
  })

  test('runs the checks that protect worker changes from known silent failures', () => {
    const run = new Set(
      STATIC_CHECKS.filter((check) => check.worker.run).map((check) => check.name),
    )
    expect(run).toEqual(
      new Set([
        'Biome',
        'scripts/check-architecture.ts',
        'scripts/check-file-ceiling.ts',
        'scripts/check-cognitive-ceiling.ts',
        'scripts/check-test-placement.ts',
        'scripts/check-dead-code.ts',
        'scripts/check-brand.ts',
        'scripts/check-legacy-names.ts',
        'orchestrator/scripts/check-canon-lint.ts',
        'scripts/quality/check-test-substance.ts',
      ]),
    )
  })
})
