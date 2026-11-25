import { describe, expect, test } from 'bun:test'
import { trackerObservationTimes } from './tracker-observation-times.ts'

const trackerTask = {
  externalId: 'tracker-alpha-1',
  key: 'ALP-1',
  project: 'alpha' as const,
  parentKey: undefined,
  title: 'Observed task',
  status: 'started',
  category: 'active' as const,
  updatedAt: null,
  assignee: null,
}

const storedTrackerTask = {
  external_id: trackerTask.externalId,
  key: trackerTask.key,
  project: trackerTask.project,
  parent_key: null,
  title: trackerTask.title,
  status: trackerTask.status,
  status_category: trackerTask.category,
  opened_at: '2026-09-01T10:00:00.000Z',
  closed_at: null,
  first_seen: '2026-09-01T10:00:00.000Z',
  last_seen: '2026-09-02T10:00:00.000Z',
  updated_at: '2026-09-01T10:00:00.000Z',
  assignee: null,
  retired_reason: null,
}

describe('tracker observation times', () => {
  const at = '2026-09-03T10:00:00.000Z'

  test('new and changed observations use the pass time when the tracker has no update time', () => {
    expect(trackerObservationTimes(trackerTask, undefined, at)).toEqual({
      openedAt: at,
      closedAt: null,
      firstSeen: at,
      lastSeen: at,
      updatedAt: at,
    })
    expect(
      trackerObservationTimes({ ...trackerTask, title: 'Changed task' }, storedTrackerTask, at),
    ).toEqual({
      openedAt: at,
      closedAt: null,
      firstSeen: storedTrackerTask.first_seen,
      lastSeen: at,
      updatedAt: at,
    })
  })

  test('an unchanged observation sends every stored time', () => {
    expect(trackerObservationTimes(trackerTask, storedTrackerTask, at)).toEqual({
      openedAt: storedTrackerTask.opened_at,
      closedAt: storedTrackerTask.closed_at,
      firstSeen: storedTrackerTask.first_seen,
      lastSeen: storedTrackerTask.last_seen,
      updatedAt: storedTrackerTask.updated_at,
    })
  })

  test('an unchanged legacy row repairs missing update and open times once', () => {
    const legacy = { ...storedTrackerTask, opened_at: null, updated_at: null }
    const repaired = trackerObservationTimes(trackerTask, legacy, at)
    expect(repaired).toEqual({
      openedAt: at,
      closedAt: legacy.closed_at,
      firstSeen: legacy.first_seen,
      lastSeen: legacy.last_seen,
      updatedAt: at,
    })

    const secondAt = '2026-09-04T10:00:00.000Z'
    expect(
      trackerObservationTimes(
        trackerTask,
        { ...legacy, opened_at: repaired.openedAt, updated_at: repaired.updatedAt },
        secondAt,
      ),
    ).toEqual(repaired)
  })

  test('a tracker update time is retained for new, changed, and unchanged observations', () => {
    const updatedAt = '2026-09-03T09:30:00.000Z'
    const supplied = { ...trackerTask, updatedAt }
    const stored = { ...storedTrackerTask, updated_at: updatedAt, opened_at: updatedAt }
    expect(trackerObservationTimes(supplied, undefined, at).updatedAt).toBe(updatedAt)
    expect(trackerObservationTimes({ ...supplied, title: 'Changed task' }, stored, at)).toEqual({
      openedAt: updatedAt,
      closedAt: null,
      firstSeen: stored.first_seen,
      lastSeen: at,
      updatedAt,
    })
    expect(trackerObservationTimes(supplied, stored, at)).toEqual({
      openedAt: updatedAt,
      closedAt: null,
      firstSeen: stored.first_seen,
      lastSeen: stored.last_seen,
      updatedAt,
    })
  })

  test('re-observing done work preserves its lifecycle times while an open task closes now', () => {
    const done = { ...trackerTask, status: 'completed', category: 'done' as const }
    const closedAt = '2026-09-02T12:00:00.000Z'
    const stored = {
      ...storedTrackerTask,
      status: done.status,
      status_category: done.category,
      closed_at: closedAt,
    }
    expect(trackerObservationTimes(done, stored, at)).toMatchObject({
      openedAt: stored.opened_at,
      closedAt,
    })
    expect(
      trackerObservationTimes({ ...done, title: 'Changed done task', updatedAt: at }, stored, at),
    ).toMatchObject({ openedAt: stored.opened_at, closedAt })
    expect(trackerObservationTimes(done, storedTrackerTask, at).closedAt).toBe(at)
  })
})
