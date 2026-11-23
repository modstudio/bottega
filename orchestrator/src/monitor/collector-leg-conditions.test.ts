import { describe, expect, test } from 'bun:test'
import {
  COLLECTOR_LEG_FAILURE_WARN_MS,
  collectorLegFailureDecision,
} from './collector-leg-conditions.ts'

const now = Date.parse('2026-11-20T12:00:00.000Z')
const leg = (failingSince: string | null) => ({
  source: 'runs',
  lastSuccessAt: '2026-11-20T11:00:00.000Z',
  lastError: failingSince ? 'ruling read unavailable' : null,
  lastErrorAt: failingSince ? '2026-11-20T11:59:00.000Z' : null,
  failingSince,
  status: failingSince ? ('failing' as const) : ('current' as const),
  ageMs: 60 * 60_000,
})

describe('collector leg failure decision', () => {
  test('fires only after the sustained-failure threshold and clears on success', () => {
    expect(
      collectorLegFailureDecision([leg(new Date(now - 9 * 60_000).toISOString())], now).conditions,
    ).toEqual([])
    expect(
      collectorLegFailureDecision(
        [leg(new Date(now - COLLECTOR_LEG_FAILURE_WARN_MS - 1).toISOString())],
        now,
      ).conditions,
    ).toEqual([
      expect.objectContaining({
        kind: 'collector-leg-failure',
        subject: 'runs',
        ageMs: COLLECTOR_LEG_FAILURE_WARN_MS + 1,
        detail: 'runs collection has failed for 10 minutes: ruling read unavailable',
      }),
    ])
    expect(collectorLegFailureDecision([leg(null)], now).conditions).toEqual([])
  })

  test('reports unreadable observations as an observation error', () => {
    expect(collectorLegFailureDecision({ source: 'runs' }, now)).toEqual({
      conditions: [],
      errors: ['collector leg observation unreadable: response was not an array'],
      failures: [],
    })
  })

  test('keeps a sustained failure when another leg is unreadable', () => {
    const result = collectorLegFailureDecision(
      [
        {
          source: 'hosted outbox',
          lastSuccessAt: null,
          lastError: 'stored collector leg state is unreadable',
          lastErrorAt: null,
          failingSince: null,
          status: 'unreadable',
          ageMs: null,
        },
        leg(new Date(now - COLLECTOR_LEG_FAILURE_WARN_MS - 1).toISOString()),
      ],
      now,
    )
    expect(result.conditions).toEqual([
      expect.objectContaining({ kind: 'collector-leg-failure', subject: 'runs' }),
    ])
    expect(result.errors).toEqual([
      'collector leg observation unreadable: hosted outbox state is unreadable',
    ])
  })
})
