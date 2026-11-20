import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { collectFast } from './collect.ts'
import {
  type CollectorLegState,
  collectorLegStates,
  collectorLegView,
} from './collector-leg-state.ts'

beforeAll(resetFixtureStore)
afterEach(resetFixtureStore)

describe('collector leg state', () => {
  test('repeated failures keep one streak, log once, and success clears it', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const fail = () =>
      collectFast(
        {
          runs: async () => {
            throw new Error('ruling read unavailable')
          },
        },
        undefined,
        'runs',
      )
    try {
      await fail()
      const first = collectorLegStates()[0]!
      await fail()
      expect(collectorLegStates()[0]).toMatchObject({
        failingSince: first.failingSince,
        lastError: 'ruling read unavailable',
      })
      expect(error).toHaveBeenCalledTimes(1)

      await collectFast(
        { runs: async () => ({ examined: 0, rows: 0, skipped: 0 }) },
        undefined,
        'runs',
      )
      expect(collectorLegStates()[0]).toMatchObject({
        lastSuccessAt: expect.any(String),
        lastError: 'ruling read unavailable',
        lastErrorAt: expect.any(String),
        failingSince: null,
      })
      expect(error).toHaveBeenLastCalledWith('hub: runs collect recovered')
    } finally {
      error.mockRestore()
    }
  })

  test('a failing leg remains visible beside a successful leg and governs freshness', () => {
    const state = (value: Partial<CollectorLegState>): CollectorLegState => ({
      source: 'runs',
      lastSuccessAt: '2026-11-20T11:00:00.000Z',
      lastError: null,
      lastErrorAt: null,
      failingSince: null,
      ...value,
    })
    const view = collectorLegView(
      [
        state({
          lastError: 'ruling read unavailable',
          lastErrorAt: '2026-11-20T11:05:00.000Z',
          failingSince: '2026-11-20T11:05:00.000Z',
        }),
        state({ source: 'transcripts', lastSuccessAt: '2026-11-20T11:59:50.000Z' }),
      ],
      Date.parse('2026-11-20T12:00:00.000Z'),
    )
    expect(view.collectedAt).toBe('2026-11-20T11:00:00.000Z')
    expect(view.collectorLegs).toEqual([
      expect.objectContaining({ source: 'runs', status: 'failing' }),
      expect.objectContaining({ source: 'transcripts', status: 'current' }),
    ])
  })
})
