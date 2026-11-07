import { describe, expect, test } from 'bun:test'
import { BoundExceededError, budgetForArgv } from './call-budgets.ts'

describe('call budgets', () => {
  test.each([
    { argv: ['gh'], budget: 'gh' },
    { argv: ['git', 'fetch'], budget: 'git-network' },
    { argv: ['git', '-C', '/x', 'ls-remote'], budget: 'git-network' },
    { argv: ['git', 'rev-parse'], budget: 'git-plumbing' },
    { argv: ['git', '-c', 'a=b', 'push'], budget: 'git-network' },
    { argv: ['git', '--git-dir', '.git', 'fetch'], budget: 'git-network' },
    { argv: ['git', '--work-tree', '/w', 'push', 'origin', 'main'], budget: 'git-network' },
    { argv: ['git', '--namespace', 'ns', 'ls-remote'], budget: 'git-network' },
    { argv: ['git', '--git-dir', '.git', 'status'], budget: 'git-plumbing' },
    { argv: ['git', '--config-env', 'A=B', 'fetch'], budget: 'git-network' },
    { argv: ['git', '--git-dir=.git', 'fetch'], budget: 'git-network' },
  ] as const)('$argv selects $budget', ({ argv, budget }) => {
    expect(budgetForArgv(argv)).toBe(budget)
  })

  test('deadline refusal names the command, budget, value, and remedy', () => {
    expect(
      new BoundExceededError('https://example.test', 'hosted-api', 'deadline', 30_000).message,
    ).toBe(
      'https://example.test exceeded its hosted-api deadline bound of 30000 ms per attempt (60000 ms total); declare a larger named budget in shared/call-budgets.ts if the call legitimately needs more',
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
