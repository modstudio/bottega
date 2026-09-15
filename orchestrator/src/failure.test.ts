import { describe, expect, test } from 'bun:test'
import { classify, clusterErrorText } from './failure.ts'

describe('stale-login classification', () => {
  /**
   * Vendors word a stale login differently — "signed in" where another says
   * "logged in" — and the wording is the only evidence available, because no
   * CLI here reports its own auth state. Missing one costs more than a failed
   * run: `other` raises no notification and triggers no cooldown, so routing
   * re-dispatches to the same unauthenticated agent immediately.
   */
  test('reads a vendor that says it is not signed in as a stale login', () => {
    const notSignedIn =
      'Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.'
    expect(classify(notSignedIn, 1)).toBe('auth')
    expect(classify('not logged in', 1)).toBe('auth')
  })

  /** Waiting fixes a spent plan and does not fix a stale login, so quota keeps its precedence. */
  test('leaves a spent plan classified as quota', () => {
    expect(classify("You've hit your usage limit. Upgrade to Pro or try again at 14:00", 1)).toBe(
      'quota',
    )
  })
})

describe('failure text clustering', () => {
  test('normalises the measured 14-day failure shapes without volatile values', () => {
    const fixtures = [
      ['exit 143, empty output', 'exit <n>, empty output'],
      [
        'timeout waiting for lock /tmp/orch-landing-991 after 30000ms',
        'timeout waiting for lock <path> after <n>ms',
      ],
      ['stale caller abcdef123 is behind 1234567', 'stale caller <id> is behind <n>'],
      [
        'MCP trust denied for /Users/someone/Projects/app/.claude/worktrees/DEV-350',
        'mcp trust denied for <path>',
      ],
      ['branch technical/DEV-350-orch-2605 has invalid format', 'branch <id> has invalid format'],
    ] as const
    for (const [text, expected] of fixtures) expect(clusterErrorText(text)).toBe(expected)
  })

  test('orders UUID, request, labelled and decimal normalization without collisions', () => {
    expect(clusterErrorText('request 123e4567-e89b-12d3-a456-426614174000 failed')).toBe(
      clusterErrorText('request 987fcdeb-51a2-43d7-9123-456789abcdef failed'),
    )
    expect(clusterErrorText('request req_01j8abcde123456789 failed')).toBe('request <id> failed')
    expect(clusterErrorText('task DEV-350 failed')).toBe('task <id> failed')
    expect(clusterErrorText('branch DEV-350 failed')).toBe('branch <id> failed')
    expect(clusterErrorText('read 999999 bytes')).toBe(clusterErrorText('read 1000000 bytes'))
    expect(clusterErrorText('read 999999 bytes')).toBe('read <n> bytes')
    expect(clusterErrorText('run 999999')).toBe('run <n>')
  })
})
