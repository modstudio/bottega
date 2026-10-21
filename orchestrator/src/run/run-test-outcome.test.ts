import { describe, expect, test } from 'bun:test'
import { deriveObservedTestOutcome } from './run-test-outcome.ts'

describe('deriveObservedTestOutcome', () => {
  test('nothing-run focus and a passing gate that skipped unit tests do not support the claim', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [],
        gate: [],
        claim: { ran: true, passed: true },
      }),
    ).toEqual({ ran: false, passed: null, claimDisagrees: true })
  })

  test('an executed passing focused run establishes the claimed outcome', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [{ executed: true, passed: true }],
        gate: [],
        claim: { ran: true, passed: true },
      }),
    ).toEqual({ ran: true, passed: true, claimDisagrees: false })
  })

  test('no tool calls records that no tests ran', () => {
    expect(deriveObservedTestOutcome({ focused: [], gate: [], claim: null })).toEqual({
      ran: false,
      passed: null,
      claimDisagrees: false,
    })
  })
})
