import { describe, expect, test } from 'bun:test'
import {
  HOSTED_HUB_NO_DESTINATION_WRITE_SOURCE,
  identityRefusal,
  identityRefusalResponse,
  recordIdentityDecision,
  taskSpaceIdentity,
} from './hosted-route-identity.ts'

test('labels hub destination-less writes apart from the record API', () => {
  expect(HOSTED_HUB_NO_DESTINATION_WRITE_SOURCE).toBe('hub')
})

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
    })) as unknown as typeof fetch

  test('records and refuses headerless writes but accepts writes whose requested space is honored', async () => {
    const records: unknown[] = []
    const counter = {
      record: async (decision: unknown) => void records.push(decision),
      read: async () => ({ windowStart: '', unrecorded: 0, counts: [] }),
    }
    const database = () => ({}) as never
    const request = (headers?: HeadersInit) =>
      new Request('https://hub.example.test/v1/tasks', {
        method: 'POST',
        headers: { authorization: 'Bearer token', ...headers },
      })

    const refused = await taskSpaceIdentity(request(), 'https://api.test', identityFetch, true, {
      counter,
      database,
    })
    expect(refused.kind).toBe('refused-destination')
    const response = identityRefusal(refused)
    expect(response?.status).toBe(409)
    expect(await response?.json()).toEqual({
      error: 'write request names no destination space',
      remedy: 'send the destination space in the x-record-space header, then retry',
    })
    expect(
      (
        await taskSpaceIdentity(
          request({ 'x-record-space': 'space-a' }),
          'https://api.test',
          identityFetch,
          true,
          { counter, database },
        )
      ).kind,
    ).toBe('authenticated')
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      spaceId: 'space-a',
      route: '/v1/tasks',
      cause: expect.any(String),
    })
  })

  test('keeps headerless reads and the user-scoped outside-note write on the active space', async () => {
    const telemetry = {
      counter: {
        record: async () => undefined,
        read: async () => ({ windowStart: '', unrecorded: 0, counts: [] }),
      },
      database: () => ({}) as never,
    }
    const read = new Request('https://hub.example.test/v1/tasks', {
      headers: { authorization: 'Bearer token' },
    })
    const outsideNote = new Request('https://hub.example.test/v1/notes/outside', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
    })

    expect(
      (await taskSpaceIdentity(read, 'https://api.test', identityFetch, true, telemetry)).kind,
    ).toBe('authenticated')
    expect(
      (await taskSpaceIdentity(outsideNote, 'https://api.test', identityFetch, true, telemetry))
        .kind,
    ).toBe('authenticated')
  })
})
