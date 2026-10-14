/** Resolves hosted document fields that an omitted write keeps from the stored row. */
import type { DocAudiences, DocKind } from '../../../shared/docs.ts'
import type { DocDelivery } from '../doc/doc-write-allowed.ts'
import { recordDocAudiences } from './record-doc-audiences.ts'

type StoredDocRow = Record<string, unknown>

export function storedDocKind(input: { kind?: DocKind }, existing?: StoredDocRow): DocKind {
  return input.kind ?? (existing?.kind == null ? 'working' : (String(existing.kind) as DocKind))
}

export function storedDocDelivery(
  input: { delivery?: DocDelivery },
  existing?: StoredDocRow,
): DocDelivery {
  return (
    input.delivery ??
    (existing?.delivery == null ? 'inject' : (String(existing.delivery) as DocDelivery))
  )
}

export function storedDocAudiences(
  input: { audiences?: DocAudiences },
  existing?: StoredDocRow,
): DocAudiences {
  return (
    input.audiences ??
    (existing?.audiences == null ? ['technical'] : recordDocAudiences(existing.audiences))
  )
}

export function storedDocParentId(
  input: { parentRecordId?: string | null },
  existing?: StoredDocRow,
): string | null {
  if (input.parentRecordId !== undefined) return input.parentRecordId
  return existing?.parent_id == null ? null : String(existing.parent_id)
}
