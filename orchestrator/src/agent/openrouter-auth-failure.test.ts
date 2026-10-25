import { expect, test } from 'bun:test'
import type { FailureKind } from '../failure/failure.ts'
import { applyOpenRouterBudgetToAuthFailure } from './openrouter-auth-failure.ts'

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
