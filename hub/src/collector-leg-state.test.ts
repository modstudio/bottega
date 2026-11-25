import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { collectFast, collectFastHostedOutbox, collectHostedOutboxOnce } from './collect.ts'
import { QUIET_MAX_MS, SLOW_MS } from './collect-cadence.ts'
import {
  type CollectorLegState,
  collectorLegStates,
  collectorLegView,
  dropUnregisteredTrackerCollectorStates,
  recordCollectorLegFailure,
  recordCollectorLegSuccess,
  recordTrackerCollectorState,
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
        consecutiveFailures: 2,
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
        consecutiveFailures: 0,
      })
      expect(error).toHaveBeenLastCalledWith('hub: runs collect recovered')
    } finally {
      error.mockRestore()
    }
  })

  test('a pass that does not read a failed tracker leaves its streak intact', () => {
    recordCollectorLegFailure('tasks:alpha', 'task_list refused', '2026-11-20T11:00:00.000Z')
    const failed = collectorLegStates().find(
      (state) => !('unreadable' in state) && state.source === 'tasks:alpha',
    )
    recordCollectorLegSuccess('tasks', '2026-11-20T11:05:00.000Z')

    expect(
      collectorLegStates().find(
        (state) => !('unreadable' in state) && state.source === 'tasks:alpha',
      ),
    ).toEqual(failed)
  })

  test('tracker results record per-project failures and success while skipped results stay untouched', () => {
    recordTrackerCollectorState(
      { project: 'alpha', error: 'task_list refused' },
      '2026-11-20T11:00:00.000Z',
    )
    recordTrackerCollectorState(
      { project: 'alpha', error: 'task_list refused again' },
      '2026-11-20T11:05:00.000Z',
    )
    recordTrackerCollectorState(
      { project: 'skipped', skipped: 'no credentials' },
      '2026-11-20T11:05:00.000Z',
    )
    recordTrackerCollectorState({ project: 'backfill' }, '2026-11-20T11:05:00.000Z')

    expect(collectorLegStates()).toEqual([
      expect.objectContaining({
        source: 'tasks:alpha',
        failingSince: '2026-11-20T11:00:00.000Z',
        consecutiveFailures: 2,
      }),
    ])

    recordTrackerCollectorState({ project: 'alpha' }, '2026-11-20T11:10:00.000Z')
    expect(collectorLegStates()).toEqual([
      expect.objectContaining({
        source: 'tasks:alpha',
        lastSuccessAt: '2026-11-20T11:10:00.000Z',
        failingSince: null,
        consecutiveFailures: 0,
      }),
    ])
  })

  test('removed tracker projects lose their leg state while registered and skipped trackers stay', () => {
    recordCollectorLegFailure('tasks:removed', 'down', '2026-11-20T11:00:00.000Z')
    recordCollectorLegFailure('tasks:registered', 'down', '2026-11-20T11:00:00.000Z')
    recordCollectorLegFailure('runs', 'down', '2026-11-20T11:00:00.000Z')

    dropUnregisteredTrackerCollectorStates(['registered'])

    expect(
      collectorLegStates().map((state) => ('unreadable' in state ? state.key : state.source)),
    ).toEqual(['runs', 'tasks:registered'])
  })

  test('a quiet tracker stays current through its next scheduled slow cadence', () => {
    const now = Date.parse('2026-11-20T12:00:00.000Z')
    const atAge = (ageMs: number) => new Date(now - ageMs).toISOString()
    const state = (source: string, ageMs: number): CollectorLegState => ({
      source,
      lastSuccessAt: atAge(ageMs),
      lastError: null,
      lastErrorAt: null,
      failingSince: null,
    })

    expect(
      collectorLegView(
        [state('tasks:alpha', QUIET_MAX_MS + SLOW_MS), state('runs', QUIET_MAX_MS + 1)],
        now,
        { count: 0, oldest: null },
      ).collectorLegs,
    ).toEqual([
      expect.objectContaining({ source: 'tasks:alpha', status: 'current' }),
      expect.objectContaining({ source: 'runs', status: 'stale' }),
    ])
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
      { count: 0, oldest: null },
    )
    expect(view.collectedAt).toBe('2026-11-20T11:00:00.000Z')
    expect(view.collectorLegs).toEqual([
      expect.objectContaining({ source: 'runs', status: 'failing' }),
      expect.objectContaining({ source: 'transcripts', status: 'current' }),
    ])
  })

  test('a leg without a first success does not blank the oldest recorded success', () => {
    const view = collectorLegView(
      [
        {
          source: 'runs',
          lastSuccessAt: '2026-11-20T11:00:00.000Z',
          lastError: null,
          lastErrorAt: null,
          failingSince: null,
        },
        {
          source: 'tasks:alpha',
          lastSuccessAt: null,
          lastError: 'task_list refused',
          lastErrorAt: '2026-11-20T11:05:00.000Z',
          failingSince: '2026-11-20T11:05:00.000Z',
        },
      ],
      Date.parse('2026-11-20T12:00:00.000Z'),
      { count: 0, oldest: null },
    )

    expect(view.collectedAt).toBe('2026-11-20T11:00:00.000Z')
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

  test('state persistence failures preserve the collector result', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
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
    } finally {
      writeTransaction((conn) => conn.exec('DROP TRIGGER reject_collector_leg_state'))
      error.mockRestore()
    }
  })

  test('an unparsable stored leg is an unreadable observation and view', () => {
    writeTransaction((conn) =>
      conn
        .query('INSERT INTO setting(key,value) VALUES (?,?)')
        .run('collect.leg.hosted%20outbox', '{not-json'),
    )

    const observations = collectorLegStates()
    expect(observations).toEqual([{ unreadable: true, key: 'collect.leg.hosted%20outbox' }])
    expect(
      collectorLegView(observations, Date.parse('2026-11-20T12:00:00.000Z'), {
        count: 0,
        oldest: null,
      }),
    ).toEqual({
      collectedAt: null,
      collectorLegs: [
        {
          source: 'hosted outbox',
          lastSuccessAt: null,
          lastError: 'stored collector leg state is unreadable',
          lastErrorAt: null,
          failingSince: null,
          status: 'unreadable',
          ageMs: null,
        },
      ],
    })
  })

  test('the hosted changes leg carries the local quarantine count and oldest row', () => {
    const states = [
      {
        source: 'hosted changes',
        lastSuccessAt: '2026-11-20T11:59:00.000Z',
        lastError: null,
        lastErrorAt: null,
        failingSince: null,
      },
    ]
    const view = collectorLegView(states, Date.parse('2026-11-20T12:00:00.000Z'), {
      count: 2,
      oldest: {
        feed: 'task',
        spaceId: 'space-one',
        table: 'hub_task',
        rowId: 'row-one',
        constraintError: 'CHECK constraint failed',
        firstQuarantinedAt: '2026-11-20T11:30:00.000Z',
      },
    })

    expect(view.collectorLegs[0]).toMatchObject({
      source: 'hosted changes',
      quarantinedRows: 2,
      oldestQuarantinedRow: {
        table: 'hub_task',
        constraintError: 'CHECK constraint failed',
        firstQuarantinedAt: '2026-11-20T11:30:00.000Z',
      },
    })
  })

  test('a fresh non-Error failure repairs an unparsable stored leg', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    writeTransaction((conn) =>
      conn
        .query('INSERT INTO setting(key,value) VALUES (?,?)')
        .run('collect.leg.runs', '{not-json'),
    )
    try {
      const result = await collectFast(
        {
          runs: async () => {
            throw 'ruling read unavailable'
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
      expect(collectorLegStates()).toEqual([
        expect.objectContaining({
          source: 'runs',
          lastError: 'ruling read unavailable',
          failingSince: expect.any(String),
        }),
      ])
    } finally {
      error.mockRestore()
    }
  })
})
