import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  applyOpenRouterBudgetToAuthFailure,
  classify,
  clusterErrorText,
  type FailureKind,
} from './failure.ts'

const exhaustedOpenRouterBudget = {
  kind: 'exhausted' as const,
  limitUsd: 250,
  usedUsd: 250.02,
  resetInterval: 'weekly',
  resetsAt: '2026-10-26T00:00:00.000Z',
}

test('an exhausted OpenRouter key maps an auth failure to billing with its refusal', () => {
  const refusal =
    "the OpenRouter key's weekly limit of $250 is used ($250.02); it resets at 2026-10-26T00:00:00.000Z; raise the key's limit in OpenRouter Keys settings"
  expect(
    applyOpenRouterBudgetToAuthFailure(
      'auth',
      'Authentication required',
      exhaustedOpenRouterBudget,
    ),
  ).toEqual({
    failureKind: 'billing',
    error: `Authentication required\n${refusal}`,
    billingHoldDetail: refusal,
  })
})

test('OpenRouter budget mapping leaves every unproved or unrelated failure unchanged', () => {
  for (const decision of [
    { kind: 'spendable' as const },
    { kind: 'unknown' as const },
    { kind: 'not-applicable' as const },
  ]) {
    expect(applyOpenRouterBudgetToAuthFailure('auth', 'Authentication required', decision)).toEqual(
      {
        failureKind: 'auth',
        error: 'Authentication required',
      },
    )
  }
  expect(
    applyOpenRouterBudgetToAuthFailure(
      'quota' satisfies FailureKind,
      'Quota exceeded',
      exhaustedOpenRouterBudget,
    ),
  ).toEqual({ failureKind: 'quota', error: 'Quota exceeded' })
})

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

  test.each([
    [
      'classifies the exact error recorded for run 19328 as auth',
      `Authentication required\nreply.json missing at /Users/shmuel/.local/state/${PLATFORM_SLUG}/orchestrator/runs/01a16ded-6847-743f-a95b-03a5556b1c13/scratch/reply.json; used final-message fallback`,
      'auth',
    ],
    ['does not match the phrase inside other words', 'xxAuthentication requiredxx', 'other'],
    [
      'keeps billing ahead of authentication',
      'Please check your account with your provider to add more credits. Authentication required.',
      'billing',
    ],
  ] as const)('%s', (_name, error, expected) => {
    expect(classify(error)).toBe(expected)
  })

  /** Waiting fixes a spent plan and does not fix a stale login, so quota keeps its precedence. */
  test('leaves a spent plan classified as quota', () => {
    expect(classify("You've hit your usage limit. Upgrade to Pro or try again at 14:00", 1)).toBe(
      'quota',
    )
  })
})

describe('vendor capacity classification', () => {
  const capacityMessage = 'Selected model is at capacity. Please try a different model.'

  test('classifies the recorded vendor message and the same message inside an event stream', () => {
    expect(classify(capacityMessage)).toBe('capacity')
    expect(
      classify(
        [
          '{"type":"thread.started","thread_id":"0199"}',
          '{"type":"item.completed","item":{"type":"reasoning","text":"unrelated"}}',
          JSON.stringify({ type: 'turn.failed', error: { message: capacityMessage } }),
        ].join('\n'),
      ),
    ).toBe('capacity')
  })

  test('run 4073 capacity wins over unrelated authentication vocabulary', () => {
    expect(classify(`${capacityMessage}\n401 unauthorized`)).toBe('capacity')
  })

  test('recognizes close capacity variants without treating a bare 503 as capacity', () => {
    expect(classify('The selected model is overloaded.')).toBe('capacity')
    expect(classify('The server is busy.')).toBe('capacity')
    expect(classify('Unable to serve this request due to capacity constraints.')).toBe('capacity')
    expect(classify('The model is temporarily unavailable.')).toBe('capacity')
    expect(classify('The engine for this request is temporarily unavailable.')).toBe('capacity')
    expect(classify('HTTP 503')).not.toBe('capacity')
    expect(classify('The service is temporarily unavailable.')).not.toBe('capacity')
  })
})

describe('billing classification', () => {
  test('classifies the recorded grok balance exhaustion and an HTTP payment status', () => {
    expect(classify('402 Grok Build usage balance exhausted')).toBe('billing')
    expect(classify('402 Payment Required')).toBe('billing')
  })

  test('classifies the recorded OpenRouter credit exhaustion without matching unrelated credits', () => {
    expect(
      classify(
        'Please check your account with your provider to add more credits, then resend your message to continue.',
      ),
    ).toBe('billing')
    expect(classify('The closing credits list the film crew.')).not.toBe('billing')
    expect(classify('The billing pattern now matches the phrase add more credits.')).not.toBe(
      'billing',
    )
  })

  test('does not treat an unrelated 402 number as a billing status', () => {
    expect(classify('orchestrator/src/x.ts:402')).not.toBe('billing')
    expect(classify('processed 402 files')).not.toBe('billing')
  })
})

describe('failure text clustering', () => {
  test('normalizes the measured 14-day failure shapes without volatile values', () => {
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

  test('orders UUID, request, labeled and decimal normalization without collisions', () => {
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
