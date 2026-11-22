import { createHash } from 'node:crypto'
import type { TrackerTask } from '../../../shared/trackers.ts'
import type { TaskRow } from '../task-row.ts'

const TRACKER_ROW_NAMESPACE = '65a73d30-9607-5a4c-a02e-2fb5573b37c4'

type StoredTrackerRow = TaskRow & { external_id: string | null }

type PlannedStatusEvent = {
  record_id: string
  task_key: string
  task_record_id: string
  at: string
  from_status: string
  to_status: string
  actor_user_id: null
  actor_name: null
  agent: null
  run_id: null
  project_name: string
  project_record_id: string | null
}

export type TrackerTaskRowPlan = {
  task: TrackerTask
  stored: StoredTrackerRow | null
  row: TaskRow
  changed: boolean
  event: PlannedStatusEvent | null
}

function uuidBytes(uuid: string): Uint8Array {
  return Uint8Array.from(Buffer.from(uuid.replaceAll('-', ''), 'hex'))
}

/** Deterministic RFC 9562 UUID version 7 with name-derived random bits. */
function trackerNameId(time: string | null, name: string): string {
  const bytes = createHash('sha1')
    .update(uuidBytes(TRACKER_ROW_NAMESPACE))
    .update(name)
    .digest()
    .subarray(0, 16)
  const parsed = time === null ? Number.NaN : Date.parse(time)
  let timestamp = BigInt(Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0)
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp & 0xffn)
    timestamp >>= 8n
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function differs(
  task: TrackerTask,
  stored: StoredTrackerRow | null,
  effectiveKey: string,
): boolean {
  if (!stored) return true
  return (
    stored.key !== effectiveKey ||
    stored.project !== task.project ||
    (task.parentKey !== undefined && stored.parent_key !== task.parentKey) ||
    (task.externalId !== null && stored.external_id !== task.externalId) ||
    stored.title !== task.title ||
    stored.status !== task.status ||
    stored.status_category !== task.category ||
    stored.assignee !== task.assignee ||
    (task.updatedAt !== null && stored.updated_at !== task.updatedAt) ||
    stored.retired_reason !== null
  )
}

function observationTimes(
  task: TrackerTask,
  stored: StoredTrackerRow | null,
  at: string,
  changed: boolean,
) {
  if (stored && !changed) {
    const updatedAt = stored.updated_at ?? at
    return {
      openedAt: stored.opened_at ?? updatedAt,
      closedAt: stored.closed_at,
      firstSeen: stored.first_seen,
      lastSeen: stored.last_seen,
      updatedAt,
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
    openedAt: stored?.opened_at ?? sourceTime,
    closedAt: task.category === 'done' ? at : null,
    firstSeen: stored?.first_seen ?? at,
    lastSeen: at,
    updatedAt: sourceTime,
  }
}

export function trackerTaskRowPlan(input: {
  task: TrackerTask
  stored: StoredTrackerRow | null
  effectiveKey: string
  parentRecordId: string | null
  at: string
  projectRecordId: string | null
}): TrackerTaskRowPlan {
  const { task, stored, effectiveKey, parentRecordId, at, projectRecordId } = input
  const changed = differs(task, stored, effectiveKey)
  const times = observationTimes(task, stored, at, changed)
  const recordId =
    stored?.record_id ??
    trackerNameId(task.updatedAt, `${projectRecordId}\0${task.externalId ?? `key:${effectiveKey}`}`)
  const row: TaskRow = {
    record_id: recordId,
    external_id: task.externalId ?? stored?.external_id ?? null,
    key: effectiveKey,
    project: task.project,
    project_record_id: projectRecordId,
    title: task.title,
    status: task.status,
    status_category: task.category,
    parent_key: task.parentKey === undefined ? (stored?.parent_key ?? null) : task.parentKey,
    parent_record_id:
      task.parentKey === undefined ? (stored?.parent_record_id ?? null) : parentRecordId,
    body: stored?.body ?? null,
    assignee: task.assignee,
    opened_at: times.openedAt,
    closed_at: times.closedAt,
    updated_at: times.updatedAt,
    source: 'mcp',
    first_seen: times.firstSeen,
    last_seen: times.lastSeen,
    next_document_number: stored?.next_document_number ?? 1,
    retired_reason: null,
    revision: stored?.revision,
  }
  const from = stored?.status_category
  const event =
    stored && stored.source !== 'local' && typeof from === 'string' && from !== task.category
      ? {
          record_id: trackerNameId(
            stored.updated_at ?? stored.last_seen,
            `${recordId}\0${from}\0${task.category}\0${stored.updated_at ?? stored.last_seen}`,
          ),
          task_key: effectiveKey,
          task_record_id: recordId,
          at,
          from_status: from,
          to_status: task.category,
          actor_user_id: null,
          actor_name: null,
          agent: null,
          run_id: null,
          project_name: task.project,
          project_record_id: projectRecordId,
        }
      : null
  return { task, stored, row, changed: changed || stored?.updated_at === null, event }
}

export type RetireRowPlan = { before: TaskRow; row: TaskRow; changed: boolean }

export function retireTrackerRowPlan(row: TaskRow, at: string, reason: string): RetireRowPlan {
  return {
    before: row,
    row: {
      ...row,
      status_category: 'dropped',
      closed_at: row.closed_at ?? at,
      retired_reason: reason,
    },
    changed: row.retired_reason === null,
  }
}
