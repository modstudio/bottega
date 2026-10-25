import { describe, expect, test } from 'bun:test'
import {
  applyOpenRouterBudgetToAuthFailure,
  checkOpenRouterKeyBudget,
  openRouterKeyBudgetDecision,
  openRouterKeyBudgetRefusal,
} from './openrouter-key-budget.ts'

const exactExhaustedResponse = {
  data: {
    label: 'must-not-appear',
    limit: 250,
    limit_reset: 'weekly',
    limit_remaining: 0,
    usage_weekly: 250.02,
    effective_budget: { resets_at: '2026-10-26T00:00:00.000Z' },
  },
}

describe('OpenRouter key budget decision', () => {
  test('accepts an unlimited key', () => {
    expect(openRouterKeyBudgetDecision({ data: { limit: null } })).toEqual({ kind: 'spendable' })
  })

  test('accepts a key with remaining spend', () => {
    expect(openRouterKeyBudgetDecision({ data: { limit: 250, limit_remaining: 0.01 } })).toEqual({
      kind: 'spendable',
    })
  })

  test('reports zero remaining spend as exhausted', () => {
    expect(
      openRouterKeyBudgetDecision({
        data: { limit: 10, limit_remaining: 0, limit_reset: 'daily', usage_daily: 10 },
      }),
    ).toEqual({
      kind: 'exhausted',
      limitUsd: 10,
      usedUsd: 10,
      resetInterval: 'daily',
      resetsAt: null,
    })
  })

  test('reports the verified negative weekly response with its reset time', () => {
    expect(
      openRouterKeyBudgetDecision({
        data: { ...exactExhaustedResponse.data, limit_remaining: -0.02 },
      }),
    ).toEqual({
      kind: 'exhausted',
      limitUsd: 250,
      usedUsd: 250.02,
      resetInterval: 'weekly',
      resetsAt: '2026-10-26T00:00:00.000Z',
    })
  })

  test('rejects missing data and non-numeric fields', () => {
    expect(openRouterKeyBudgetDecision({})).toEqual({ kind: 'unknown' })
    expect(
      openRouterKeyBudgetDecision({
        data: {
          limit: '250',
          limit_remaining: '0',
          limit_reset: 'weekly',
          usage_weekly: '250.02',
        },
      }),
    ).toEqual({ kind: 'unknown' })
  })
})

test('the adapter asks the keyed OpenRouter endpoint without network', async () => {
  let request: { url: string; authorization: string | null; signal: AbortSignal | null } = {
    url: '',
    authorization: null,
    signal: null,
  }
  const decision = await checkOpenRouterKeyBudget(
    {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeySecret: 'OPENROUTER_FIXTURE_KEY',
    },
    {
      resolve: async () => ({ OPENAI_API_KEY: 'fixture-secret' }),
      fetch: async (input, init) => {
        request = {
          url: String(input),
          authorization: new Headers(init?.headers).get('Authorization'),
          signal: init?.signal ?? null,
        }
        return new Response(JSON.stringify(exactExhaustedResponse), { status: 200 })
      },
    },
  )

  expect(decision.kind).toBe('exhausted')
  expect(request).toEqual({
    url: 'https://openrouter.ai/api/v1/key',
    authorization: 'Bearer fixture-secret',
    signal: expect.any(AbortSignal),
  })
})

test('the exhaustion refusal names amounts and reset without response secrets', () => {
  const decision = openRouterKeyBudgetDecision(exactExhaustedResponse)
  if (decision.kind !== 'exhausted') throw new Error('fixture must be exhausted')
  const refusal = openRouterKeyBudgetRefusal(decision)
  expect(refusal).toContain('weekly limit of $250')
  expect(refusal).toContain('used ($250.02)')
  expect(refusal).toContain('2026-10-26T00:00:00.000Z')
  expect(refusal).not.toContain('must-not-appear')
  expect(refusal).not.toContain('secret')
  expect(applyOpenRouterBudgetToAuthFailure('auth', 'Authentication required', decision)).toEqual({
    failureKind: 'billing',
    error: refusal,
  })
})
