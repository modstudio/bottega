// concern: record-doc-mapping
/** Maps untrusted SQL row shapes into the hosted document service model. */
import type { DocAudience } from '../../../shared/docs.ts'
import type { DocDelivery, DocRevisionOp, RecordDoc, RecordDocRevision } from './record-docs.ts'

export const recordDocIso = (value: unknown) =>
  value == null ? null : new Date(String(value)).toISOString()

export function recordDocRow(row: Record<string, unknown>): RecordDoc {
  return {
    id: String(row.id), spaceId: String(row.space_id), spaceName: String(row.space_name),
    scope: String(row.scope), subject: row.subject == null ? null : String(row.subject),
    owner: row.owner_user_id == null ? null : String(row.owner_user_id), slug: String(row.slug),
    title: String(row.title), body: String(row.body), delivery: String(row.delivery) as DocDelivery,
    audience: String(row.audience) as DocAudience,
    parentId: row.parent_id == null ? null : String(row.parent_id), position: Number(row.position),
    projectName: row.project_name == null ? null : String(row.project_name),
    createdAt: recordDocIso(row.created_at)!, updatedAt: recordDocIso(row.updated_at)!,
    deletedAt: recordDocIso(row.deleted_at),
  }
}

export function recordDocRevisionRow(row: Record<string, unknown>): RecordDocRevision {
  return {
    id: String(row.id), docId: String(row.doc_id), scope: String(row.scope),
    subject: row.subject == null ? null : String(row.subject),
    owner: row.owner_user_id == null ? null : String(row.owner_user_id), slug: String(row.slug),
    op: String(row.op) as DocRevisionOp, title: String(row.title), body: String(row.body),
    delivery: String(row.delivery) as DocDelivery, audience: String(row.audience) as DocAudience,
    parentId: row.parent_id == null ? null : String(row.parent_id), position: Number(row.position),
    author: String(row.author), reason: String(row.reason),
    sessionId: row.session_id == null ? null : String(row.session_id), at: recordDocIso(row.at)!,
  }
}
