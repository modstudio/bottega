import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { collectFast, collectFastHostedOutbox, collectHostedOutboxOnce } from './collect.ts'
import {
  type CollectorLegState,
  collectorLegStates,
  collectorLegView,
} from './collector-leg-state.ts'
import { writeTransaction } from './db.ts'
import type { HostedOutboxReport } from './outbox.ts'
import { HostedOutboxDrainSchedule } from './outbox-fast-cycle.ts'

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
      if ('unreadable' in first) throw new Error('expected readable collector leg state')
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

  test('a skipped fast tick leaves an existing failure streak untouched', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const pending = { pendingCount: 1, newestQueuedAt: '2026-11-20T11:59:59.000Z' }
    const waiting: HostedOutboxReport = {
      queued: 1,
      sent: 0,
      rejected: 0,
      quarantined: 0,
      dropped: 0,
      waitingOnRouting: { alpha: 1 },
      waitingOnHostedHub: {},
      skippedCapability: false,
    }
    const schedule = new HostedOutboxDrainSchedule(
      async () => waiting,
      () => '2026-11-20T12:00:00.000Z',
    )
    try {
      await collectHostedOutboxOnce(async () => {
        throw new Error('hosted record unavailable')
      })
      const failure = collectorLegStates()[0]
      expect(failure).toMatchObject({
        source: 'hosted outbox',
        failingSince: expect.any(String),
      })

      await schedule.fast(pending)
      expect(await collectFastHostedOutbox(schedule, { pending: () => pending })).toBeNull()
      expect(collectorLegStates()[0]).toEqual(failure)
    } finally {
      error.mockRestore()
    }
  })

  test('state persistence failures preserve the collector result and report both errors', async () => {
    const errors: string[] = []
    const error = spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))
    writeTransaction((conn) =>
      conn.exec(`CREATE TRIGGER reject_collector_leg_state
        BEFORE INSERT ON setting
        WHEN NEW.key LIKE 'collect.leg.%'
        BEGIN SELECT RAISE(ABORT, 'collector leg state unavailable'); END`),
    )
    try {
      const result = await collectFast(
        {
          runs: async () => {
            throw new Error('ruling read unavailable')
          },
        },
        undefined,
        'runs',
      )
      expect(result[0]).toMatchObject({
        source: 'runs',
        ok: false,
        error: 'ruling read unavailable',
      })
      expect(errors).toEqual([
        'hub: runs collect failed: ruling read unavailable',
        'hub: runs collector state failed: collector leg state unavailable',
      ])
    } finally {
      writeTransaction((conn) => conn.exec('DROP TRIGGER reject_collector_leg_state'))
      error.mockRestore()
    }
  })

  test('an unparsable stored leg is an unreadable observation and a stale view', () => {
    writeTransaction((conn) =>
      conn
        .query('INSERT INTO setting(key,value) VALUES (?,?)')
        .run('collect.leg.hosted%20outbox', '{not-json'),
    )

    const observations = collectorLegStates()
    expect(observations).toEqual([{ unreadable: true, key: 'collect.leg.hosted%20outbox' }])
    expect(collectorLegView(observations)).toEqual({
      collectedAt: null,
      collectorLegs: [
        {
          source: 'hosted outbox',
          lastSuccessAt: null,
          lastError: 'stored collector leg state is unreadable',
          lastErrorAt: null,
          failingSince: null,
          status: 'stale',
          ageMs: null,
        },
      ],
    })
  })
})
