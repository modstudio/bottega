import { describe, expect, test } from 'bun:test'
import { SLOW_MS } from './collect-cadence.ts'
import { SLOW_COLLECTION_STALE_CADENCES, slowCollectionHealth } from './collect-slow-health.ts'

describe('slow collection health', () => {
  const now = Date.parse('2026-11-09T16:00:00.000Z')
  const atAge = (ageMs: number) => new Date(now - ageMs).toISOString()

  test('becomes stale only after three slow cadences', () => {
    const threshold = SLOW_COLLECTION_STALE_CADENCES * SLOW_MS
    expect(slowCollectionHealth(now, atAge(threshold))).toEqual({
      status: 'current',
      ageMs: threshold,
    })
    expect(slowCollectionHealth(now, atAge(threshold + 1))).toEqual({
      status: 'stale',
      ageMs: threshold + 1,
    })
  })

  test('reports a missing or invalid completion stamp as unhealthy', () => {
    expect(slowCollectionHealth(now, null)).toEqual({ status: 'missing', ageMs: null })
    expect(slowCollectionHealth(now, 'not-a-time')).toEqual({ status: 'invalid', ageMs: null })
  })
})
