import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  coolingRefusal,
  decideCoolingFailures,
  providerErrorStreakCooling,
  QUOTA_RESET_CEILING_MS,
  QUOTA_RESET_READING_WINDOW_MS,
  type RecentTerminalRun,
  recentTerminalRuns,
} from './routing-cooldown.ts'

const NOW = Date.parse('2026-11-19T04:00:00.000Z')

const row = (overrides: Partial<RecentTerminalRun> = {}): RecentTerminalRun => {
  const minsAgo = overrides.mins_ago ?? 1
  return {
    record_id: crypto.randomUUID(),
    number: 1,
    agent: 'a',
    job: 'craft',
    status: 'failed',
    failure_kind: 'provider_error',
    endpoint_key_source: null,
    credential_id: null,
    quota_resets_at: null,
    finished_at: Date.now() - minsAgo * 60_000,
    mins_ago: minsAgo,
    ...overrides,
  }
}

test('three consecutive provider errors cool the agent', () => {
  expect(providerErrorStreakCooling([row(), row(), row()], 60, Date.now())).toMatchObject({
    agent: 'a',
    failure_kind: 'provider_error',
  })
})

test('two provider errors followed by a success do not cool the agent', () => {
  expect(
    providerErrorStreakCooling(
      [row(), row(), row({ status: 'ok', failure_kind: null, mins_ago: 3 })],
      60,
      Date.now(),
    ),
  ).toBeNull()
})

test('a successful probe clears the provider-error streak', () => {
  expect(
    providerErrorStreakCooling(
      [row(), row(), row({ job: 'agent-probe', status: 'ok', failure_kind: null })],
      60,
      Date.now(),
    ),
  ).toBeNull()
})

test('a vendor reset keeps quota cooling active beyond the minimum', () => {
  const resetAt = NOW + 41 * 60 * 60_000
  const quota = row({
    failure_kind: 'quota',
    finished_at: NOW - 61 * 60_000,
    mins_ago: 61,
    quota_resets_at: resetAt / 1_000,
  })

  const failure = decideCoolingFailures([quota], 60, NOW).get('a')!
  expect(failure).toMatchObject({
    vendor_reset_at: new Date(resetAt).toISOString(),
  })
  expect(coolingRefusal('a', failure, 60, 'America/Los_Angeles')).toContain(
    'Nov 20, 2026, 1:00 PM PST (vendor reset)',
  )
  expect(decideCoolingFailures([quota], 60, resetAt + 1_000).get('a')).toBeUndefined()
})

test('stored quota reset keeps the agent cooling beyond the minimum', () => {
  const agent = 'stored-reset-agent'
  const resetAt = NOW + 41 * 60 * 60_000
  const run = addRun({
    agent,
    job: 'craft',
    status: 'failed',
    kind: 'quota',
    startedAt: new Date(NOW - 61 * 60_000 - 1_000).toISOString(),
  })
  db()
    .query('UPDATE run SET quota_resets_at=? WHERE record_id=?')
    .run(resetAt / 1_000, run)

  const failure = decideCoolingFailures(recentTerminalRuns(db(), [agent], NOW), 60, NOW).get(agent)
  expect(failure?.vendor_reset_at).toBe(new Date(resetAt).toISOString())
  expect(failure).toBeDefined()
})

test('a reset beyond the ceiling is ignored and named in the refusal', () => {
  const quota = row({
    failure_kind: 'quota',
    finished_at: NOW - 5 * 60_000,
    mins_ago: 5,
    quota_resets_at: (NOW + QUOTA_RESET_CEILING_MS + 1_000) / 1_000,
  })
  const failure = decideCoolingFailures([quota], 60, NOW).get('a')!

  expect(failure).toMatchObject({ vendor_reset_at: null, vendor_reset_clamped: true })
  expect(coolingRefusal('a', failure, 60, 'America/New_York')).toContain(
    'beyond the 192h ceiling was ignored',
  )
  expect(coolingRefusal('a', failure, 60, 'America/New_York')).toContain(
    `${PLATFORM_SLUG} agent probe a`,
  )
})

test('past and stale reset readings do not extend quota cooling', () => {
  const quota = row({ failure_kind: 'quota', finished_at: NOW - 61 * 60_000, mins_ago: 61 })
  expect(
    decideCoolingFailures([{ ...quota, quota_resets_at: (NOW - 1_000) / 1_000 }], 60, NOW).get('a'),
  ).toBeUndefined()
  expect(
    decideCoolingFailures(
      [
        {
          ...quota,
          finished_at: NOW - QUOTA_RESET_READING_WINDOW_MS - 1_000,
          quota_resets_at: (NOW + 60 * 60_000) / 1_000,
        },
      ],
      60,
      NOW,
    ).get('a'),
  ).toBeUndefined()
})

test("a sibling's numeric reading bounds a quota cooldown", () => {
  const resetAt = NOW + 41 * 60 * 60_000
  const quota = row({ failure_kind: 'quota', finished_at: NOW - 5 * 60_000, mins_ago: 5 })
  const sibling = row({
    failure_kind: 'contract',
    finished_at: NOW - 2 * 60_000,
    mins_ago: 2,
    quota_resets_at: resetAt / 1_000,
  })
  expect(decideCoolingFailures([quota, sibling], 60, NOW).get('a')?.vendor_reset_at).toBe(
    new Date(resetAt).toISOString(),
  )
})

test('a successful probe after quota clears reset-bounded cooling', () => {
  const quota = row({
    failure_kind: 'quota',
    finished_at: NOW - 5 * 60_000,
    mins_ago: 5,
    quota_resets_at: (NOW + 41 * 60 * 60_000) / 1_000,
  })
  const probe = row({
    job: 'agent-probe',
    status: 'ok',
    failure_kind: null,
    finished_at: NOW - 60_000,
    mins_ago: 1,
  })
  expect(decideCoolingFailures([quota, probe], 60, NOW).get('a')).toBeUndefined()
})

test('daily quota remains bounded by the UTC day', () => {
  const daily = row({
    failure_kind: 'daily_quota',
    finished_at: Date.parse('2026-11-19T00:01:00.000Z'),
    mins_ago: 239,
    quota_resets_at: (NOW + 41 * 60 * 60_000) / 1_000,
  })
  expect(decideCoolingFailures([daily], 60, NOW).get('a')?.failure_kind).toBe('daily_quota')
  expect(
    decideCoolingFailures([daily], 60, Date.parse('2026-11-20T00:00:00.000Z')).get('a'),
  ).toBeUndefined()
})
