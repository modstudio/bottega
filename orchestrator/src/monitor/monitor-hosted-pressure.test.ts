import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import {
  checkHostedPressureCached,
  HOSTED_API_APP,
  HOSTED_FLY_METRICS_TOKEN,
  HOSTED_METRICS_INTERVAL_MS,
  HOSTED_METRICS_ORG,
  HOSTED_METRICS_QUERIES,
  HOSTED_METRICS_QUERY_BUDGET_MS,
  HOSTED_METRICS_WINDOW,
  HOSTED_RECORD_APP,
} from './monitor-hosted-pressure.ts'

const base = Date.parse('2026-10-30T12:00:00.000Z')

test('exports the ruled Fly metric names and budget', () => {
  expect({
    org: HOSTED_METRICS_ORG,
    record: HOSTED_RECORD_APP,
    api: HOSTED_API_APP,
    window: HOSTED_METRICS_WINDOW,
    token: HOSTED_FLY_METRICS_TOKEN,
    budget: HOSTED_METRICS_QUERY_BUDGET_MS,
  }).toEqual({
    org: PLATFORM_SLUG,
    record: `${PLATFORM_SLUG}-record`,
    api: `${PLATFORM_SLUG}-api`,
    window: '5m',
    token: 'BOTTEGA_FLY_METRICS_TOKEN',
    budget: 3_000,
  })
})

test('the machine cache runs one four-query observation per interval', async () => {
  let calls = 0
  const fetcher = (async () => {
    calls++
    return Response.json({ status: 'success', data: { result: [{ value: [base, '0'] }] } })
  }) as unknown as typeof fetch
  const dependencies = {
    database: db(),
    fetch: fetcher,
    resolveToken: async () => ({ BOTTEGA_FLY_METRICS_TOKEN: 'token' }),
  }
  await checkHostedPressureCached({ ...dependencies, clock: base })
  await checkHostedPressureCached({ ...dependencies, clock: base + 1_000 })
  expect(calls).toBe(Object.keys(HOSTED_METRICS_QUERIES).length)
  await checkHostedPressureCached({
    ...dependencies,
    clock: base + HOSTED_METRICS_INTERVAL_MS,
  })
  expect(calls).toBe(Object.keys(HOSTED_METRICS_QUERIES).length * 2)
})

test('authorization accepts both bare and already-prefixed Fly tokens', async () => {
  const authorizations: string[] = []
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get('Authorization') ?? '')
    return Response.json({ status: 'success', data: { result: [{ value: [base, '0'] }] } })
  }) as unknown as typeof fetch
  for (const [offset, token] of [
    [0, 'bare-token'],
    [HOSTED_METRICS_INTERVAL_MS, 'FlyV1 prefixed-token'],
  ] as const) {
    await checkHostedPressureCached({
      database: db(),
      clock: base + offset,
      fetch: fetcher,
      resolveToken: async () => ({ BOTTEGA_FLY_METRICS_TOKEN: token }),
    })
  }
  expect(new Set(authorizations)).toEqual(new Set(['FlyV1 bare-token', 'FlyV1 prefixed-token']))
})

test('a failed query is stored and returned as an observation error', async () => {
  const result = await checkHostedPressureCached({
    database: db(),
    clock: base,
    fetch: (async (input: RequestInfo | URL) => {
      const query = new URL(String(input)).searchParams.get('query')
      return query?.includes('mode="steal"')
        ? new Response('', { status: 503 })
        : Response.json({ status: 'success', data: { result: [{ value: [base, '0'] }] } })
    }) as unknown as typeof fetch,
    resolveToken: async () => ({ BOTTEGA_FLY_METRICS_TOKEN: 'token' }),
  })
  expect(result.conditions[0]).toEqual(
    expect.objectContaining({
      kind: 'observation-error',
      detail: expect.stringContaining('steal failed: Error: HTTP 503'),
    }),
  )
  expect(
    db().query('SELECT last_error FROM hosted_pressure_cache WHERE singleton=1').get(),
  ).toEqual({ last_error: 'hosted metrics query steal failed: Error: HTTP 503' })
})
