import { describe, expect, test } from 'bun:test'
import {
  identityRefusalResponse,
  recordIdentityDecision,
  taskSpaceIdentity,
} from './hosted-route-identity.ts'

describe('record identity decision', () => {
  test('keeps a 401 distinct from record unavailability', async () => {
    const decision = recordIdentityDecision(401, { error: 'expired' })
    expect(decision).toEqual({ kind: 'unauthenticated' })
    if (decision.kind === 'authenticated') throw new Error('expected an identity refusal')
    expect(await identityRefusalResponse(decision).json()).toMatchObject({
      error: 'record session is missing or expired',
      remedy: expect.stringContaining('record sign-in'),
    })
  })

  test('turns a record 503 into an unavailable refusal', async () => {
    const decision = recordIdentityDecision(503, { error: 'offline' })
    expect(decision).toEqual({ kind: 'unavailable', cause: '503' })
    if (decision.kind === 'authenticated') throw new Error('expected an identity refusal')
    const response = identityRefusalResponse(decision)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'record API unavailable (503)',
      remedy: 'nothing was written; retry',
    })
  })
})

describe('hosted destination-less write recording', () => {
  const identityFetch = (async () =>
    Response.json({
      user: { id: 'user-a', name: 'A' },
      activeSpaceId: 'space-a',
      memberships: [{ space_id: 'space-a', slug: 'active', permission: 'write' }],
    })) as typeof fetch

  test('records headerless writes but not writes whose requested space is honored', async () => {
    const records: unknown[] = []
    const counter = ((input: unknown) => records.push(input)) as never
    const request = (headers?: HeadersInit) =>
      new Request('https://hub.example.test/v1/tasks', {
        method: 'POST',
        headers: { authorization: 'Bearer token', ...headers },
      })

    expect(
      (await taskSpaceIdentity(request(), 'https://api.test', identityFetch, true, { counter }))
        .kind,
    ).toBe('authenticated')
    expect(
      (
        await taskSpaceIdentity(
          request({ 'x-record-space': 'space-a' }),
          'https://api.test',
          identityFetch,
          true,
          { counter },
        )
      ).kind,
    ).toBe('authenticated')
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      record: { spaceId: 'space-a', route: '/v1/tasks', cause: expect.any(String) },
    })
  })

  test('a throwing counter does not fail identity resolution', async () => {
    const result = await taskSpaceIdentity(
      new Request('https://hub.example.test/v1/tasks', {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
      }),
      'https://api.test',
      identityFetch,
      true,
      {
        counter: (() => {
          throw new Error('counter failed')
        }) as never,
      },
    )
    expect(result.kind).toBe('authenticated')
  })
})
