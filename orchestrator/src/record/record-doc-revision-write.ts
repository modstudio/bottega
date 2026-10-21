// concern: record-doc-revision-write
/** Owns complete hosted document revision snapshots and the live revision pointer. */
import type { SQL } from 'bun'
import type { DocAudiences, DocForm, DocKind, DocStatus } from '../../../shared/docs.ts'
import { bindJsonb } from '../../../shared/record/jsonb-sql.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import type { DocDelivery, DocRevisionOp } from '../doc/doc-write-allowed.ts'
import { bindRecordDocAudiences } from './record-doc-audience-sql.ts'

function normalizedJson(value: unknown): string {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  return JSON.stringify(Array.isArray(parsed) ? [...parsed].sort() : parsed)
}

function isSameRevisionSnapshot(
  row: Record<string, unknown>,
  input: Parameters<typeof insertRecordDocRevision>[1],
): boolean {
  return (
    String(row.space_id) === input.spaceId &&
    String(row.doc_id) === input.docId &&
    String(row.scope) === input.scope &&
    (row.subject ?? null) === input.subject &&
    (row.owner_user_id == null ? null : String(row.owner_user_id)) === input.owner &&
    String(row.slug) === input.slug &&
    (row.project_id == null ? null : String(row.project_id)) === input.projectId &&
    String(row.title) === input.title &&
    String(row.body) === input.body &&
    String(row.op) === input.op &&
    String(row.delivery) === input.delivery &&
    normalizedJson(row.audiences) === normalizedJson(input.audiences) &&
    (row.parent_id == null ? null : String(row.parent_id)) === input.parentId &&
    Number(row.position) === input.position &&
    Boolean(row.featured) === (input.featured ?? false) &&
    String(row.status) === (input.status ?? 'current') &&
    String(row.kind) === (input.kind ?? 'working') &&
    (row.form ?? null) === (input.form ?? null) &&
    (row.article_subject_id == null ? null : String(row.article_subject_id)) ===
      (input.articleSubjectId ?? null) &&
    normalizedJson(row.related_subject_ids) === normalizedJson(input.relatedSubjectIds ?? []) &&
    normalizedJson(row.source_files) === normalizedJson(input.sourceFiles ?? []) &&
    (row.checked_against_commit ?? null) === (input.checkedAgainstCommit ?? null) &&
    (row.summary ?? null) === (input.summary ?? null) &&
    (row.replacement_slug ?? null) === (input.replacementSlug ?? null) &&
    String(row.author) === input.author &&
    String(row.reason) === input.reason &&
    (row.session_id ?? null) === input.sessionId &&
    new Date(String(row.at)).toISOString() === new Date(input.at).toISOString()
  )
}

export async function insertRecordDocRevision(
  tx: SQL,
  input: {
    id?: string
    spaceId: string
    docId: string
    scope: string
    subject: string | null
    owner: string | null
    slug: string
    projectId: string | null
    op: DocRevisionOp
    title: string
    body: string
    delivery: DocDelivery
    audiences: DocAudiences
    parentId: string | null
    position: number
    featured?: boolean
    status?: DocStatus
    kind?: DocKind
    form?: DocForm | null
    articleSubjectId?: string | null
    relatedSubjectIds?: string[]
    sourceFiles?: string[]
    checkedAgainstCommit?: string | null
    summary?: string | null
    replacementSlug?: string | null
    author: string
    reason: string
    sessionId: string | null
    at: string
  },
): Promise<string> {
  const id = input.id ?? newRecordId()
  const existing = input.id
    ? await tx`SELECT id,space_id,doc_id,scope,subject,owner_user_id,slug,project_id,op,title,body,delivery,audiences,parent_id,position,featured,status,kind,form,article_subject_id,related_subject_ids,source_files,checked_against_commit,summary,replacement_slug,author,reason,session_id,at FROM doc_revision WHERE id=${id}::uuid`
    : await tx`
        SELECT id FROM doc_revision
        WHERE space_id=${input.spaceId}::uuid AND doc_id=${input.docId}::uuid
          AND at=${input.at}::timestamptz AND op=${input.op}
          AND author=${input.author} AND reason=${input.reason}
      `
  const storedId = existing[0] ? String(existing[0].id) : id
  if (input.id && existing[0]) {
    const row = existing[0] as Record<string, unknown>
    if (!isSameRevisionSnapshot(row, input))
      throw new Error(
        `document revision UUID ${id} already belongs to another space, document, or content`,
      )
  }
  if (!existing[0]) {
    await tx`
      INSERT INTO doc_revision (
        id, space_id, doc_id, scope, subject, owner_user_id, slug, project_id, op, title, body, delivery, audiences, featured, status, kind, form, article_subject_id, related_subject_ids, source_files, checked_against_commit, summary, replacement_slug, parent_id, position,
        author, reason, session_id, at
      ) VALUES (
        ${id}::uuid, ${input.spaceId}::uuid, ${input.docId}::uuid, ${input.scope}, ${input.subject}, ${input.owner}::uuid,
        ${input.slug}, ${input.projectId}::uuid, ${input.op}, ${input.title}, ${input.body},
        ${input.delivery}, ${bindRecordDocAudiences(tx, input.audiences)}, ${input.featured ?? false}, ${input.status ?? 'current'}, ${input.kind ?? 'working'}, ${input.form ?? null}, ${input.articleSubjectId ?? null}::uuid, ${bindJsonb(tx, input.relatedSubjectIds ?? [])}, ${bindJsonb(tx, input.sourceFiles ?? [])}, ${input.checkedAgainstCommit ?? null}, ${input.summary ?? null}, ${input.replacementSlug ?? null}, ${input.parentId}::uuid, ${input.position}, ${input.author}, ${input.reason}, ${input.sessionId}, ${input.at}::timestamptz
      )
    `
  }
  await tx`
    UPDATE doc SET latest_revision_id=${storedId}::uuid
    WHERE space_id=${input.spaceId}::uuid AND id=${input.docId}::uuid
  `
  return storedId
}
