import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import {
  checkHostedPressureCached,
  HOSTED_METRICS_INTERVAL_MS,
  HOSTED_METRICS_ORG,
  HOSTED_METRICS_QUERIES,
} from './monitor-hosted-pressure.ts'

const base = Date.parse('2026-10-30T12:00:00.000Z')

test('the machine cache runs one four-query observation per interval', async () => {
  let calls = 0
  const paths: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    calls++
    paths.push(new URL(String(input)).pathname)
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
  expect(new Set(paths)).toEqual(new Set([`/prometheus/${HOSTED_METRICS_ORG}/api/v1/query`]))
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

test('a fail-fast store claim restores the connection busy timeout', async () => {
  const database = db()
  database.exec('PRAGMA busy_timeout = 4321')
  await checkHostedPressureCached({
    database,
    clock: base,
    fetch: (async () =>
      Response.json({
        status: 'success',
        data: { result: [{ value: [base, '0'] }] },
      })) as unknown as typeof fetch,
    resolveToken: async () => ({ BOTTEGA_FLY_METRICS_TOKEN: 'token' }),
    failFastStoreClaim: true,
  })
  expect(database.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 4321 })
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
