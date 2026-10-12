import { DELETED_ON_HOSTED_RECORD_REASON } from './hosted-delete.ts'
import { mergeNoteAnchors } from './note-anchor-merge.ts'
import type {
  PushedDocument,
  PushedNote,
  PushedNoteAcknowledgement,
  PushedTask,
} from './push-contract.ts'

type Decision<Row> =
  | { kind: 'duplicate' }
  | { kind: 'reject'; reason: string }
  | { kind: 'insert'; row: Row }
  | { kind: 'replace'; row: Row }
  | {
      kind: 'patch'
      values: Partial<Row>
      resolveParent?: { key: string | null; preferred: string | null }
    }

const instant = (value: unknown) =>
  value instanceof Date
    ? value.toISOString()
    : value === null || value === undefined
      ? value
      : new Date(String(value)).toISOString()
const same = (left: unknown, right: unknown) =>
  left instanceof Date || right instanceof Date ? instant(left) === instant(right) : left === right
const later = (left: string, right: string) =>
  new Date(left).getTime() >= new Date(right).getTime()
    ? (instant(left) as string)
    : (instant(right) as string)

export function decideNoteUpsert(
  stored: PushedNote,
  incoming: PushedNote,
  fields: readonly string[],
): Decision<PushedNote> {
  if (stored.deleted_at) return { kind: 'reject', reason: DELETED_ON_HOSTED_RECORD_REASON }
  const selected = new Set(fields)
  const merged = selected.has('anchors')
    ? mergeNoteAnchors(
        JSON.parse(stored.anchors) as Array<{ id?: string }>,
        JSON.parse(incoming.anchors) as Array<{ id?: string }>,
      )
    : {
        anchors: JSON.parse(stored.anchors) as Array<{ id?: string }>,
        sightings: stored.sightings,
        appended: 0,
      }
  const values: Partial<PushedNote> = {
    anchors: JSON.stringify(merged.anchors),
    sightings: merged.sightings,
    last_seen_at: selected.has('last_seen_at')
      ? later(String(stored.last_seen_at), incoming.last_seen_at)
      : (instant(stored.last_seen_at) as string),
    stale_at:
      merged.appended > 0 ? null : selected.has('stale_at') ? incoming.stale_at : stored.stale_at,
    stale_reason:
      merged.appended > 0
        ? null
        : selected.has('stale_reason')
          ? incoming.stale_reason
          : stored.stale_reason,
  }
  if (
    same(values.anchors, stored.anchors) &&
    values.sightings === stored.sightings &&
    same(values.last_seen_at, stored.last_seen_at) &&
    same(values.stale_at, stored.stale_at) &&
    values.stale_reason === stored.stale_reason
  )
    return { kind: 'duplicate' }
  return { kind: 'patch', values }
}

export function decideNoteAcknowledgementUpsert(
  stored: PushedNoteAcknowledgement | null,
  incoming: PushedNoteAcknowledgement,
): Decision<PushedNoteAcknowledgement> {
  const acknowledgedAt = stored
    ? later(String(stored.acknowledged_at), incoming.acknowledged_at)
    : (instant(incoming.acknowledged_at) as string)
  if (
    stored &&
    !stored.deleted_at &&
    same(stored.acknowledged_at, acknowledgedAt) &&
    stored.sightings === incoming.sightings
  )
    return { kind: 'duplicate' }
  if (!stored) return { kind: 'insert', row: incoming }
  return {
    kind: 'patch',
    values: {
      acknowledged_at: acknowledgedAt,
      sightings: incoming.sightings,
      updated_at: later(String(stored.updated_at), incoming.updated_at),
      deleted_at: null,
    },
  }
}

export function decideTaskUpsert(
  stored: PushedTask | null,
  incoming: PushedTask,
  fields: readonly string[] | null,
): Decision<PushedTask> {
  if (stored?.deleted_at) return { kind: 'reject', reason: DELETED_ON_HOSTED_RECORD_REASON }
  if (!stored) return { kind: 'insert', row: incoming }
  if (fields === null) {
    const compared: Array<keyof PushedTask> = [
      'project_name',
      'key',
      'project',
      'title',
      'status',
      'status_category',
      'parent_key',
      'body',
      'assignee',
      'opened_at',
      'closed_at',
      'source',
      'updated_at',
      'deleted_at',
    ]
    if (
      compared.every((field) => same(stored[field], incoming[field])) &&
      stored.next_document_number >= incoming.next_document_number
    )
      return { kind: 'duplicate' }
    return { kind: 'replace', row: incoming }
  }
  if (
    fields.every((field) =>
      same(stored[field as keyof PushedTask], incoming[field as keyof PushedTask]),
    )
  )
    return { kind: 'duplicate' }
  const values: Partial<PushedTask> = {}
  for (const field of fields)
    Object.assign(values, { [field]: incoming[field as keyof PushedTask] })
  values.updated_at = later(String(stored.updated_at), incoming.updated_at)
  values.last_seen = later(String(stored.last_seen), incoming.updated_at)
  const changesStatus = fields.includes('status') || fields.includes('status_category')
  if (changesStatus)
    values.closed_at =
      incoming.status_category === 'done' ? (stored.closed_at ?? incoming.updated_at) : null
  return {
    kind: 'patch',
    values,
    ...(fields.includes('parent_key')
      ? { resolveParent: { key: incoming.parent_key, preferred: incoming.parent_id ?? null } }
      : {}),
  }
}

export function decideDocumentUpsert(
  stored: PushedDocument | null,
  incoming: PushedDocument,
  fields: readonly string[] | null,
): Decision<PushedDocument> {
  if (stored?.deleted_at) return { kind: 'reject', reason: DELETED_ON_HOSTED_RECORD_REASON }
  if (!stored) return { kind: 'insert', row: incoming }
  if (fields === null) {
    const compared: Array<keyof PushedDocument> = [
      'number',
      'task_key',
      'task_id',
      'project_name',
      'role',
      'title',
      'body',
      'version',
      'created_at',
      'updated_at',
      'deleted_at',
    ]
    return compared.every((field) => same(stored[field], incoming[field]))
      ? { kind: 'duplicate' }
      : { kind: 'replace', row: incoming }
  }
  if (
    fields.every((field) =>
      same(stored[field as keyof PushedDocument], incoming[field as keyof PushedDocument]),
    )
  )
    return { kind: 'duplicate' }
  const values: Partial<PushedDocument> = {}
  for (const field of fields)
    Object.assign(values, { [field]: incoming[field as keyof PushedDocument] })
  values.updated_at = later(stored.updated_at, incoming.updated_at)
  return { kind: 'patch', values }
}
