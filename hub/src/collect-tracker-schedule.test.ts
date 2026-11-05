import { describe, expect, test } from 'bun:test'
import {
  formatCollectLeg,
  oneShotTrackerSelection,
  SLOW_MS,
  TrackerPollSchedule,
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

test('one-shot tracker selection skips only fresh projects unless tasks are forced', () => {
  const projects = ['fresh', 'stale', 'never']
  expect(oneShotTrackerSelection(projects, new Set(['fresh']), false)).toEqual({
    only: new Set(['stale', 'never']),
    skippedFresh: 1,
  })
  expect(oneShotTrackerSelection(projects, new Set(['fresh']), true)).toEqual({
    only: null,
    skippedFresh: 0,
  })
  expect(
    formatCollectLeg({
      source: 'tasks',
      ok: true,
      durationMs: 1,
      trackerCounts: { read: 2, skippedFresh: 1 },
    }),
  ).toBe('tasks             ok (2 trackers read, 1 skipped fresh)')
})
