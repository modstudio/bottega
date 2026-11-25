import type { StatusCategory } from '../../../shared/tracker-status-category.ts'
import type { TrackerTask } from '../../../shared/trackers.ts'

export type ExistingTrackerTask = {
  external_id: string | null
  key: string
  project: string
  parent_key: string | null
  title: string | null
  status: string | null
  status_category: StatusCategory | null
  opened_at: string | null
  closed_at: string | null
  first_seen: string
  last_seen: string
  updated_at: string | null
  assignee: string | null
  retired_reason: string | null
}

export function trackerTaskDiffers(
  task: TrackerTask,
  old: ExistingTrackerTask | undefined,
  effectiveKey = task.key,
): boolean {
  if (!old) return true
  return (
    old.key !== effectiveKey ||
    old.project !== task.project ||
    (task.parentKey !== undefined && old.parent_key !== task.parentKey) ||
    (task.externalId !== null && old.external_id !== task.externalId) ||
    old.title !== task.title ||
    old.status !== task.status ||
    old.status_category !== task.category ||
    old.assignee !== task.assignee ||
    (task.updatedAt !== null && old.updated_at !== task.updatedAt) ||
    old.retired_reason != null
  )
}

export type TrackerObservationTimes = {
  openedAt: string | null
  closedAt: string | null
  firstSeen: string
  lastSeen: string
  updatedAt: string
}

/** Preserve machine times when a tracker observation carries no semantic change. */
export function trackerObservationTimes(
  task: TrackerTask,
  stored: ExistingTrackerTask | undefined,
  at: string,
  effectiveKey = task.key,
): TrackerObservationTimes {
  if (stored && !trackerTaskDiffers(task, stored, effectiveKey)) {
    const repairedUpdateTime = stored.updated_at ?? at
    return {
      openedAt: stored.opened_at ?? repairedUpdateTime,
      closedAt: stored.closed_at,
      firstSeen: stored.first_seen,
      lastSeen: stored.last_seen,
      updatedAt: repairedUpdateTime,
    }
  }
  const sourceTime = task.updatedAt ?? at
  if (stored?.status_category === 'done' && task.category === 'done')
    return {
      openedAt: stored.opened_at ?? sourceTime,
      closedAt: stored.closed_at ?? at,
      firstSeen: stored.first_seen,
      lastSeen: at,
      updatedAt: sourceTime,
    }
  return {
    openedAt: sourceTime,
    closedAt: task.category === 'done' ? at : null,
    firstSeen: stored?.first_seen ?? at,
    lastSeen: at,
    updatedAt: sourceTime,
  }
}
