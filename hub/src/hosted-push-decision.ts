import type { PushedDocument, PushedTask } from './push-contract.ts'
import { DELETED_ON_HOSTED_RECORD_REASON } from './pending-hosted-edit.ts'

type Decision<Row> =
  | { kind: 'duplicate' }
  | { kind: 'reject'; reason: string }
  | { kind: 'insert'; row: Row }
  | { kind: 'replace'; row: Row }
  | { kind: 'patch'; values: Partial<Row>; resolveParent?: { key: string | null; preferred: string | null } }

const instant = (value: unknown) =>
  value instanceof Date ? value.toISOString() : value === null || value === undefined ? value : new Date(String(value)).toISOString()
const same = (left: unknown, right: unknown) =>
  left instanceof Date || right instanceof Date ? instant(left) === instant(right) : left === right
const later = (left: string, right: string) =>
  new Date(left).getTime() >= new Date(right).getTime() ? left : right

export function decideTaskUpsert(
  stored: PushedTask | null,
  incoming: PushedTask,
  fields: readonly string[] | null,
): Decision<PushedTask> {
  if (stored?.deleted_at) return { kind: 'reject', reason: DELETED_ON_HOSTED_RECORD_REASON }
  if (!stored) return { kind: 'insert', row: incoming }
  if (fields === null) {
    const compared: Array<keyof PushedTask> = [
      'project_name', 'key', 'project', 'title', 'status', 'status_category', 'parent_key',
      'body', 'assignee', 'opened_at', 'closed_at', 'source', 'updated_at', 'deleted_at',
    ]
    if (compared.every((field) => same(stored[field], incoming[field])) && stored.next_document_number >= incoming.next_document_number)
      return { kind: 'duplicate' }
    return { kind: 'replace', row: incoming }
  }
  if (fields.every((field) => same(stored[field as keyof PushedTask], incoming[field as keyof PushedTask])))
    return { kind: 'duplicate' }
  const values: Partial<PushedTask> = {}
  for (const field of fields) Object.assign(values, { [field]: incoming[field as keyof PushedTask] })
  values.updated_at = later(String(stored.updated_at), incoming.updated_at)
  values.last_seen = later(String(stored.last_seen), incoming.updated_at)
  const changesStatus = fields.includes('status') || fields.includes('status_category')
  if (changesStatus)
    values.closed_at = incoming.status_category === 'done' ? stored.closed_at ?? incoming.updated_at : null
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
      'number', 'task_key', 'task_id', 'project_name', 'role', 'title', 'body', 'version',
      'created_at', 'updated_at', 'deleted_at',
    ]
    return compared.every((field) => same(stored[field], incoming[field]))
      ? { kind: 'duplicate' }
      : { kind: 'replace', row: incoming }
  }
  if (fields.every((field) => same(stored[field as keyof PushedDocument], incoming[field as keyof PushedDocument])))
    return { kind: 'duplicate' }
  const values: Partial<PushedDocument> = {}
  for (const field of fields)
    Object.assign(values, { [field]: incoming[field as keyof PushedDocument] })
  values.updated_at = later(stored.updated_at, incoming.updated_at)
  return { kind: 'patch', values }
}
