import { describe, expect, test } from 'bun:test'
import {
  COLLECTOR_LEG_FAILURE_WARN_MS,
  collectorLegFailureDecision,
  TRACKER_CONSECUTIVE_FAILURE_THRESHOLD,
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

  test('fires for two consecutive tracker failures regardless of elapsed time', () => {
    const recent = new Date(now - 1_000).toISOString()
    const tracker = {
      ...leg(recent),
      source: 'tasks:stopal',
      consecutiveFailures: TRACKER_CONSECUTIVE_FAILURE_THRESHOLD,
    }
    expect(
      collectorLegFailureDecision([{ ...tracker, consecutiveFailures: 1 }], now).conditions,
    ).toEqual([])
    expect(collectorLegFailureDecision([tracker], now).conditions).toEqual([
      expect.objectContaining({
        kind: 'collector-leg-failure',
        subject: 'tasks:stopal',
        since: recent,
        detail:
          'tasks:stopal collection failed 2 consecutive reads (0 minutes since the first): ruling read unavailable',
      }),
    ])
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

  test('raises a hosted-row quarantine condition from the enriched collector payload', () => {
    const firstQuarantinedAt = '2026-11-20T11:30:00.000Z'
    const result = collectorLegFailureDecision(
      [
        {
          ...leg(null),
          source: 'hosted changes',
          quarantinedRows: 2,
          oldestQuarantinedRow: {
            table: 'hub_task',
            constraintError: 'CHECK constraint failed: status_category',
            firstQuarantinedAt,
          },
        },
      ],
      now,
    )

    expect(result.conditions).toEqual([
      expect.objectContaining({
        kind: 'hosted-row-quarantined',
        subject: 'hosted changes',
        since: firstQuarantinedAt,
        detail:
          '2 hosted rows are quarantined; oldest is hub_task: CHECK constraint failed: status_category',
        action: expect.stringContaining('record collector-legs --quarantined --json'),
      }),
    ])
  })

  test('an old collector payload without quarantine fields means zero quarantined rows', () => {
    expect(collectorLegFailureDecision([{ ...leg(null), source: 'hosted changes' }], now)).toEqual({
      conditions: [],
      errors: [],
      failures: [],
    })
  })
})
