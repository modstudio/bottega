import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { DB_PATH, db } from '../database/db.ts'
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
    resolveToken: async () => 'token',
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
      resolveToken: async () => token,
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
    resolveToken: async () => 'token',
    failFastStoreClaim: true,
  })
  expect(database.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 4321 })
})

test('a fail-fast store claim rejects promptly under a held writer and restores the busy timeout', async () => {
  const database = db()
  database.exec('PRAGMA busy_timeout = 4321')
  const writer = new Database(DB_PATH, { readwrite: true })
  writer.exec('BEGIN IMMEDIATE')
  try {
    await expect(
      checkHostedPressureCached({ database, clock: base, failFastStoreClaim: true }),
    ).rejects.toThrow()
    expect(database.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 4321 })
  } finally {
    writer.exec('ROLLBACK')
    writer.close()
  }
}, 1_000)

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
    resolveToken: async () => 'token',
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

test('the observation budget includes token resolution', async () => {
  const database = db()
  let fetchCalled = false
  const result = await checkHostedPressureCached({
    database,
    clock: base,
    fetch: (async () => {
      fetchCalled = true
      throw new Error('metrics fetch must not run without a token')
    }) as unknown as typeof fetch,
    resolveToken: async () => await new Promise<never>(() => {}),
    observeBudgetMs: 50,
  })

  expect(result.conditions[0]).toEqual(
    expect.objectContaining({
      kind: 'observation-error',
      detail: expect.stringContaining(
        'could not observe: hosted unreachable (token resolve exceeded 50 ms)',
      ),
    }),
  )
  expect(
    database.query('SELECT last_error FROM hosted_pressure_cache WHERE singleton=1').get(),
  ).toEqual({
    last_error: 'could not observe: hosted unreachable (token resolve exceeded 50 ms)',
  })
  expect(fetchCalled).toBeFalse()
})

test('a query-stage observation budget failure is recorded as a budget failure', async () => {
  const result = await checkHostedPressureCached({
    database: db(),
    clock: base,
    fetch: (async () => await new Promise<never>(() => {})) as unknown as typeof fetch,
    resolveToken: async () => 'token',
    observeBudgetMs: 50,
  })

  expect(result.conditions[0]).toEqual(
    expect.objectContaining({
      kind: 'observation-error',
      subject: 'hosted-metrics:budget',
      detail: expect.stringContaining('exceeded its budget'),
    }),
  )
  expect(result.conditions[0]?.detail).not.toContain('board refresh')
})

test('a failed onset post preserves the state and records the announcement error', async () => {
  let postInput: { audience?: string; purpose?: string; expiresAt?: string } | undefined
  let stateDuringPost: string | undefined
  const database = db()
  const result = await checkHostedPressureCached({
    database,
    clock: base,
    env: {
      BOTTEGA_RECORD_API_URL: 'https://record.example.test',
      CLAUDE_CODE_SESSION_ID: 'hosted-pressure-monitor',
    },
    fetch: (async (input: RequestInfo | URL) => {
      const query = new URL(String(input)).searchParams.get('query')
      const value = query?.includes('mode="steal"') ? '0.25' : '0'
      return Response.json({ status: 'success', data: { result: [{ value: [base, value] }] } })
    }) as unknown as typeof fetch,
    resolveToken: async () => 'token',
    boardClient: {
      listBoardMessages: async () => ({ messages: [], truncated: false }),
      postBoardMessage: async (input) => {
        postInput = input
        stateDuringPost = (
          database.query('SELECT state FROM hosted_pressure_cache WHERE singleton=1').get() as {
            state: string
          }
        ).state
        throw new Error('board unavailable')
      },
      withdrawBoardMessage: async () => {
        throw new Error('unexpected withdrawal')
      },
    },
  })
  expect(result.state.status).toBe('pressure')
  expect(postInput).toMatchObject({ audience: 'architects:all', purpose: 'request' })
  expect(JSON.parse(stateDuringPost!)).toEqual(result.state)
  const row = database
    .query('SELECT state,last_error FROM hosted_pressure_cache WHERE singleton=1')
    .get() as { state: string; last_error: string }
  expect(JSON.parse(row.state)).toEqual(result.state)
  expect(row.last_error).toBe('hosted pressure announcement failed: Error: board unavailable')
})
