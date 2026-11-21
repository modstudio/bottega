import { canonicalJson } from '../../shared/canonical-json.ts'
import { later, nullableRecordIso, sameRecordInstant } from '../../shared/record-timestamp.ts'
import { DELETED_ON_HOSTED_RECORD_REASON } from './hosted-delete.ts'
import { mergeNoteAnchors } from './note-anchor-merge.ts'
import type {
  GuardedPushTable,
  ParsedHostedPushChange,
  PushedDocument,
  PushedNote,
  PushedNoteAcknowledgement,
  PushedTask,
} from './push-contract.ts'
import { GUARDED_REVISION_FIELDS, RECORD_TIMESTAMP_FIELDS } from './push-contract.ts'

type GuardedStoredRow = object & { revision?: number; version?: string }

export type PushGuardDecision =
  | { kind: 'ok' }
  | {
      kind: 'revision-conflict'
      expected: number | string
      current: number | string | null
      key: string
    }
  | {
      kind: 'field-conflict'
      field: string
      currentValue: unknown
      currentRevision: number | string | null
      key: string
    }

function changeKey(input: ParsedHostedPushChange): string {
  if (input.op === 'delete') return input.id
  const row = input.row as unknown as Record<string, unknown>
  return String(row.key ?? row.task_key ?? input.id)
}

function storedRevision(
  input: ParsedHostedPushChange,
  current: GuardedStoredRow | undefined,
): number | string | null {
  const field = GUARDED_REVISION_FIELDS[input.table as GuardedPushTable]
  return field
    ? (((current as Record<string, unknown> | undefined)?.[field] as number | string) ?? null)
    : null
}

export function decidePushGuards(
  input: ParsedHostedPushChange,
  current: GuardedStoredRow | undefined,
): PushGuardDecision {
  const currentRevision = storedRevision(input, current)
  if (input.expected_revision !== undefined) {
    const matches =
      input.expected_revision === 0
        ? current === undefined
        : current !== undefined && currentRevision === input.expected_revision
    if (!matches)
      return {
        kind: 'revision-conflict',
        expected: input.expected_revision,
        current: currentRevision,
        key: changeKey(input),
      }
  }
  for (const [field, expected] of Object.entries(input.from ?? {})) {
    const currentValue = (current as Record<string, unknown> | undefined)?.[field] ?? null
    if (current === undefined || !same(field, currentValue, expected))
      return {
        kind: 'field-conflict',
        field,
        currentValue,
        currentRevision,
        key: changeKey(input),
      }
  }
  return { kind: 'ok' }
}

export function changeFingerprint(input: ParsedHostedPushChange): string {
  const { change_id: _changeId, ...payload } = input
  return new Bun.CryptoHasher('sha256').update(canonicalJson(payload)).digest('hex')
}

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

const scalar = (value: unknown) =>
  value === null || (typeof value !== 'object' && typeof value !== 'function')
const isRecordTimestampField = (field: string): field is (typeof RECORD_TIMESTAMP_FIELDS)[number] =>
  RECORD_TIMESTAMP_FIELDS.includes(field as (typeof RECORD_TIMESTAMP_FIELDS)[number])
const same = (field: string, left: unknown, right: unknown) => {
  if (isRecordTimestampField(field)) return sameRecordInstant(left, right)
  return scalar(left) && scalar(right)
    ? left === right
    : canonicalJson(left) === canonicalJson(right)
}
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
      ? later(stored.last_seen_at, incoming.last_seen_at)
      : nullableRecordIso(stored.last_seen_at)!,
    stale_at:
      merged.appended > 0 ? null : selected.has('stale_at') ? incoming.stale_at : stored.stale_at,
    stale_reason:
      merged.appended > 0
        ? null
        : selected.has('stale_reason')
          ? incoming.stale_reason
          : stored.stale_reason,
    promoted_task: selected.has('promoted_task') ? incoming.promoted_task : stored.promoted_task,
    promoted_task_id: selected.has('promoted_task_id')
      ? incoming.promoted_task_id
      : stored.promoted_task_id,
  }
  if (
    same('anchors', values.anchors, stored.anchors) &&
    values.sightings === stored.sightings &&
    same('last_seen_at', values.last_seen_at, stored.last_seen_at) &&
    same('stale_at', values.stale_at, stored.stale_at) &&
    values.stale_reason === stored.stale_reason &&
    values.promoted_task === stored.promoted_task &&
    values.promoted_task_id === stored.promoted_task_id
  )
    return { kind: 'duplicate' }
  return { kind: 'patch', values }
}

export function decideNoteAcknowledgementUpsert(
  stored: PushedNoteAcknowledgement | null,
  incoming: PushedNoteAcknowledgement,
): Decision<PushedNoteAcknowledgement> {
  const acknowledgedAt = stored
    ? later(stored.acknowledged_at, incoming.acknowledged_at)
    : nullableRecordIso(incoming.acknowledged_at)!
  if (
    stored &&
    !stored.deleted_at &&
    same('acknowledged_at', stored.acknowledged_at, acknowledgedAt) &&
    stored.sightings === incoming.sightings
  )
    return { kind: 'duplicate' }
  if (!stored) return { kind: 'insert', row: incoming }
  return {
    kind: 'patch',
    values: {
      acknowledged_at: acknowledgedAt,
      sightings: incoming.sightings,
      updated_at: later(stored.updated_at, incoming.updated_at),
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
      compared.every((field) => same(field, stored[field], incoming[field])) &&
      (!Object.hasOwn(incoming, 'retired_reason') ||
        same('retired_reason', stored.retired_reason ?? null, incoming.retired_reason ?? null)) &&
      stored.next_document_number >= incoming.next_document_number
    )
      return { kind: 'duplicate' }
    return { kind: 'replace', row: incoming }
  }
  if (
    fields.every((field) =>
      same(field, stored[field as keyof PushedTask], incoming[field as keyof PushedTask]),
    )
  )
    return { kind: 'duplicate' }
  const values: Partial<PushedTask> = {}
  for (const field of fields)
    Object.assign(values, { [field]: incoming[field as keyof PushedTask] })
  values.updated_at = later(stored.updated_at, incoming.updated_at)
  values.last_seen = later(stored.last_seen, incoming.updated_at)
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
    return compared.every((field) => same(field, stored[field], incoming[field]))
      ? { kind: 'duplicate' }
      : { kind: 'replace', row: incoming }
  }
  if (
    fields.every((field) =>
      same(field, stored[field as keyof PushedDocument], incoming[field as keyof PushedDocument]),
    )
  )
    return { kind: 'duplicate' }
  const values: Partial<PushedDocument> = {}
  for (const field of fields)
    Object.assign(values, { [field]: incoming[field as keyof PushedDocument] })
  values.updated_at = later(stored.updated_at, incoming.updated_at)
  return { kind: 'patch', values }
}
