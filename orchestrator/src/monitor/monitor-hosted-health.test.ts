import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { recordHostedCallOutcome } from '../hosted-call-outcome.ts'
import type { HostedHealthDecision } from './hosted-health-decision.ts'
import { HOSTED_HEALTH_WINDOW_MS } from './hosted-health-decision.ts'
import { HOSTED_CLIENT_HEALTH_NOTICE_PREFIX } from './hosted-pressure-announcement.ts'
import { announcementActions, checkHostedHealth } from './monitor-hosted-health.ts'

const decision = (
  health: HostedHealthDecision['health'],
  latestSuccess: boolean | null = health === 'healthy',
): HostedHealthDecision => ({
  health,
  counts: { calls: 3, failures: 3, recentFailures: 3, slow: 0 },
  latestSuccess,
})

test('unknown with a latest success withdraws this machine outage notice', () => {
  expect(
    announcementActions(
      decision('unknown', true),
      [{ id: 'notice-a', title: `${HOSTED_CLIENT_HEALTH_NOTICE_PREFIX} machine-a unreachable` }],
      'machine-a',
    ),
  ).toEqual([{ kind: 'withdraw', id: 'notice-a' }])
})

test('unknown with no calls leaves this machine outage notice in place', () => {
  expect(
    announcementActions(
      decision('unknown', null),
      [{ id: 'notice-a', title: `${HOSTED_CLIENT_HEALTH_NOTICE_PREFIX} machine-a unreachable` }],
      'machine-a',
    ),
  ).toEqual([])
})

test('unknown with a latest failure leaves this machine outage notice in place', () => {
  expect(
    announcementActions(
      decision('unknown', false),
      [{ id: 'notice-a', title: `${HOSTED_CLIENT_HEALTH_NOTICE_PREFIX} machine-a unreachable` }],
      'machine-a',
    ),
  ).toEqual([])
})

test('checkHostedHealth reads only the recent window into its unreachable condition', async () => {
  const database = migratedTestDatabase()
  const now = Date.parse('2026-11-08T12:00:00.000Z')
  const failure = (millisecondsAgo: number) =>
    recordHostedCallOutcome(
      {
        observedAt: new Date(now - millisecondsAgo).toISOString(),
        routeClass: 'record-docs',
        httpStatus: 503,
        transportError: null,
        latencyMs: 20,
      },
      database,
    )
  try {
    failure(HOSTED_HEALTH_WINDOW_MS + 1)
    failure(3_000)
    failure(2_000)
    failure(1_000)

    const result = await checkHostedHealth(database, now, { env: {} })

    expect(result.conditions).toEqual([
      expect.objectContaining({
        kind: 'hosted-unreachable',
        subject: 'hosted-record',
        detail:
          'Hosted health is unreachable: 3 calls, 3 failures, 3 consecutive recent failures, 0 slow calls.',
      }),
    ])
  } finally {
    database.close()
  }
})

test('checkHostedHealth reports when its hosted notice cannot be posted', async () => {
  const database = migratedTestDatabase()
  const now = Date.parse('2026-11-08T12:00:00.000Z')
  try {
    for (const age of [3_000, 2_000, 1_000])
      recordHostedCallOutcome(
        {
          observedAt: new Date(now - age).toISOString(),
          routeClass: 'record-docs',
          httpStatus: 503,
          transportError: null,
          latencyMs: 20,
        },
        database,
      )
    const result = await checkHostedHealth(database, now, {
      env: { BOTTEGA_RECORD_API_URL: 'https://record.test' },
      boardClient: {
        listBoardMessages: async () => {
          throw new Error('fixture announcement failure')
        },
        postBoardMessage: async () => {
          throw new Error('unexpected post')
        },
        withdrawBoardMessage: async () => {
          throw new Error('unexpected withdrawal')
        },
      },
    })
    expect(result.conditions[0]?.action).toBe(
      'reported; the hosted pressure notice could not be posted',
    )
  } finally {
    database.close()
  }
})

test("one machine's healthy observation never withdraws another machine's notice", () => {
  expect(
    announcementActions(
      decision('healthy'),
      [
        { id: 'notice-a', title: `${HOSTED_CLIENT_HEALTH_NOTICE_PREFIX} machine-a unreachable` },
        { id: 'notice-b', title: `${HOSTED_CLIENT_HEALTH_NOTICE_PREFIX} machine-b unreachable` },
      ],
      'machine-b',
    ),
  ).toEqual([{ kind: 'withdraw', id: 'notice-b' }])
})

test('an unreachable observation posts a machine-scoped notice without touching another machine', () => {
  expect(
    announcementActions(
      decision('unreachable'),
      [{ id: 'notice-a', title: `${HOSTED_CLIENT_HEALTH_NOTICE_PREFIX} machine-a unreachable` }],
      'machine-b',
    ),
  ).toEqual([
    {
      kind: 'post',
      notice: expect.objectContaining({
        title: `${HOSTED_CLIENT_HEALTH_NOTICE_PREFIX} machine-b unreachable`,
      }),
    },
  ])
})
