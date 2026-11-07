import { describe, expect, test } from 'bun:test'
import { BoundExceededError, CALL_BUDGETS } from './call-budgets.ts'

describe('call budgets', () => {
  test('requires a named budget lookup with both bounds', () => {
    expect(CALL_BUDGETS['git-plumbing']).toEqual({
      deadlineMs: 30_000,
      outputBytes: 16 * 1024 * 1024,
      graceMs: 2_000,
    })
  })

  test('deadline refusal names the command, budget, value, and remedy', () => {
    expect(new BoundExceededError('git status', 'git-plumbing', 'deadline', 30_000).message).toBe(
      'git status exceeded its git-plumbing deadline bound of 30000 ms; declare a larger named budget in shared/call-budgets.ts if the call legitimately needs more',
    )
  })

  test('output refusal names the URL, budget, value, and remedy', () => {
    expect(
      new BoundExceededError('https://example.test', 'hosted-api', 'output', 16_777_216).message,
    ).toBe(
      'https://example.test exceeded its hosted-api output bound of 16777216 bytes; declare a larger named budget in shared/call-budgets.ts if the call legitimately needs more',
    )
  })
})
