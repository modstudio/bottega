import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  formatCollectLeg,
  oneShotTrackerSelection,
  SLOW_MS,
  TrackerPollSchedule,
  WATCH_LIVE_MS,
  watcherLive,
} from './collect.ts'
import type { TrackerResult } from './ingest/trackers.ts'

describe('tracker poll schedule', () => {
  let now = 1_000_000
  const clock = () => now
  const result = (fields: Partial<TrackerResult> = {}): TrackerResult => ({
    project: 'alpha',
    tasks: 10,
    changed: 0,
    activity: false,
    ...fields,
  })

  test('backs a quiet project off and returns to the floor as soon as change is observed', () => {
    const schedule = new TrackerPollSchedule(clock)
    expect([...schedule.due(['alpha'])]).toEqual(['alpha'])

    schedule.record(result())
    now += 2 * SLOW_MS - 1
    expect([...schedule.due(['alpha'])]).toEqual([])
    now++
    expect([...schedule.due(['alpha'])]).toEqual(['alpha'])

    schedule.record(result())
    now += 3 * SLOW_MS
    expect([...schedule.due(['alpha'])]).toEqual(['alpha'])

    schedule.record(result({ activity: true, changed: 1 }))
    now += SLOW_MS
    expect([...schedule.due(['alpha'])]).toEqual(['alpha'])
  })

  test('backs failures off independently without delaying healthy projects', () => {
    const schedule = new TrackerPollSchedule(clock)
    const fixtures = [
      result({ project: 'down', error: 'timeout' }),
      result({ project: 'healthy', activity: true }),
    ]
    for (const item of fixtures) schedule.record(item)

    now += SLOW_MS
    expect([...schedule.due(['down', 'healthy'])]).toEqual(['healthy'])
    schedule.record(result({ project: 'healthy', activity: true }))

    now += SLOW_MS
    expect([...schedule.due(['down', 'healthy'])].sort()).toEqual(['down', 'healthy'])
    schedule.record(result({ project: 'down', error: 'timeout' }))

    now += 2 * SLOW_MS
    expect(schedule.due(['down']).size).toBe(0)
    now += 2 * SLOW_MS
    expect([...schedule.due(['down'])]).toEqual(['down'])
  })
})

test('watcher heartbeat is live through its age boundary', () => {
  const now = Date.parse('2026-11-05T12:00:00.000Z')
  const alive = (at: number) => JSON.stringify({ holder: 'watcher', pid: 123, at: new Date(at) })

  expect(watcherLive(alive(now - WATCH_LIVE_MS), now)).toBeTrue()
  expect(watcherLive(alive(now - WATCH_LIVE_MS - 1), now)).toBeFalse()
  expect(watcherLive('{malformed', now)).toBeFalse()
  expect(watcherLive(null, now)).toBeFalse()
})

test('one-shot tracker selection leaves trackers to a live watcher', () => {
  const projects = ['fresh', 'stale', 'never']
  expect(oneShotTrackerSelection(projects, new Set(['fresh']), false, true)).toEqual({
    only: new Set(),
    skippedFresh: 0,
    leftToWatcher: 3,
  })
})

test('one-shot tracker selection skips only fresh projects with a stale watcher', () => {
  const projects = ['fresh', 'stale', 'never']
  expect(oneShotTrackerSelection(projects, new Set(['fresh']), false, false)).toEqual({
    only: new Set(['stale', 'never']),
    skippedFresh: 1,
    leftToWatcher: 0,
  })
})

test('forcing tasks selects every tracker despite a live watcher', () => {
  const projects = ['fresh', 'stale', 'never']
  expect(oneShotTrackerSelection(projects, new Set(['fresh']), true, true)).toEqual({
    only: null,
    skippedFresh: 0,
    leftToWatcher: 0,
  })
})

test('tasks output names only the reasons that skipped trackers', () => {
  expect(
    formatCollectLeg({
      source: 'tasks',
      ok: true,
      durationMs: 1,
      trackerCounts: { read: 0, skippedFresh: 0, leftToWatcher: 4 },
    }),
  ).toBe(
    `tasks             ok (0 trackers read, 4 left to the watcher; force with ${PLATFORM_SLUG} record pull --only tasks)`,
  )
  expect(
    formatCollectLeg({
      source: 'tasks',
      ok: true,
      durationMs: 1,
      trackerCounts: { read: 2, skippedFresh: 1, leftToWatcher: 0 },
    }),
  ).toBe('tasks             ok (2 trackers read, 1 skipped fresh)')
})

test('an all-zero hosted changes report formats as ok', () => {
  expect(
    formatCollectLeg({
      source: 'hosted changes',
      ok: true,
      durationMs: 1,
      hostedChanges: {
        families: [
          {
            name: 'tasks',
            report: {
              upsertsChanged: 0,
              upsertsNoop: 0,
              deletesApplied: 0,
              deletesSkipped: 0,
              absentParentSkipped: 0,
              resets: 0,
              spaces: [
                {
                  spaceId: 'space-one',
                  upsertsChanged: 0,
                  upsertsNoop: 0,
                  deletesApplied: 0,
                  deletesSkipped: 0,
                  absentParentSkipped: 0,
                  resets: 0,
                },
              ],
            },
          },
        ],
      },
    }),
  ).toBe('hosted changes    ok')
})
