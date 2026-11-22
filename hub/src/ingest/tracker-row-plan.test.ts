import { describe, expect, test } from 'bun:test'
import type { TrackerTask } from '../../../shared/trackers.ts'
import type { TaskRow } from '../task-row.ts'
import { retireTrackerRowPlan, trackerTaskRowPlan } from './tracker-row-plan.ts'

const at = '2026-11-22T12:00:00.000Z'
const projectRecordId = '01990000-0000-7000-8000-000000002583'
const task: TrackerTask = {
  externalId: 'tracker-2583',
  key: 'DEV-2583',
  project: 'fixture',
  title: 'Record first',
  status: 'open',
  category: 'open',
  updatedAt: at,
  assignee: null,
  parentKey: null,
}

function plan(stored: TaskRow | null = null, incoming: TrackerTask = task) {
  return trackerTaskRowPlan({
    task: incoming,
    stored,
    effectiveKey: incoming.key,
    parentRecordId: null,
    at,
    projectRecordId,
  })
}

describe('tracker row plan', () => {
  test('inserts with a deterministic RFC 9562 version 7 id', () => {
    const first = plan()
    const second = plan()
    expect(first.changed).toBeTrue()
    expect(first.row.record_id).toBe(second.row.record_id)
    expect(first.row.record_id[14]).toBe('7')
  })

  test('different tracker update times keep the same new-task id', () => {
    const first = trackerTaskRowPlan({
      task: { ...task, updatedAt: '2026-11-20T12:00:00.000Z' },
      stored: null,
      effectiveKey: task.key,
      parentRecordId: null,
      at,
      projectRecordId,
    })
    const second = trackerTaskRowPlan({
      task: { ...task, updatedAt: '2026-11-21T12:00:00.000Z' },
      stored: null,
      effectiveKey: task.key,
      parentRecordId: null,
      at: '2026-11-23T12:00:00.000Z',
      projectRecordId,
    })
    expect(first.row.record_id).toBe(second.row.record_id)
  })

  test('a locally owned row is unchanged and has no event', () => {
    const local = { ...plan().row, source: 'local' as const }
    const observed = plan(local, { ...task, status: 'active', category: 'active' })
    expect(observed.changed).toBeFalse()
    expect(observed.event).toBeNull()
  })

  test('does not send an unchanged row (mutation: dropping the change filter fails)', () => {
    const inserted = plan().row
    expect(plan(inserted).changed).toBeFalse()
  })

  test('uses one deterministic event id for a repeated transition (mutation: random ids fail)', () => {
    const stored = plan().row
    const active = { ...task, status: 'active', category: 'active' as const }
    const first = plan(stored, active)
    const second = plan(stored, active)
    expect(first.event?.record_id).toBe(second.event?.record_id)
    expect(first.event).toMatchObject({ from_status: 'open', to_status: 'active' })
  })

  test('retires by closing once and retaining the other exact row values', () => {
    const stored = plan().row
    const retired = retireTrackerRowPlan(stored, at, 'out of scope')
    expect(retired.changed).toBeTrue()
    expect(retired.row).toEqual({
      ...stored,
      status_category: 'dropped',
      closed_at: at,
      retired_reason: 'out of scope',
    })
  })
})
