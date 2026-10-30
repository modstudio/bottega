import { describe, expect, test } from 'bun:test'
import { identityRefusalResponse, recordIdentityDecision } from './hosted-route-identity.ts'

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
