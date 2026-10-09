// concern: record-doc-revision-write
/** Owns complete hosted document revision snapshots and the live revision pointer. */
import type { SQL } from 'bun'
import type { DocAudiences, DocKind, DocStatus } from '../../../shared/docs.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import type { DocDelivery, DocRevisionOp } from '../doc/doc-write-allowed.ts'

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
    replacementSlug?: string | null
    author: string
    reason: string
    sessionId: string | null
    at: string
  },
): Promise<string> {
  const id = input.id ?? newRecordId()
  const existing = input.id
    ? await tx`SELECT id FROM doc_revision WHERE space_id=${input.spaceId}::uuid AND id=${id}::uuid`
    : await tx`
        SELECT id FROM doc_revision
        WHERE space_id=${input.spaceId}::uuid AND doc_id=${input.docId}::uuid
          AND at=${input.at}::timestamptz AND op=${input.op}
          AND author=${input.author} AND reason=${input.reason}
      `
  const storedId = existing[0] ? String(existing[0].id) : id
  if (!existing[0]) {
    await tx`
      INSERT INTO doc_revision (
        id, space_id, doc_id, scope, subject, owner_user_id, slug, project_id, op, title, body, delivery, audiences, featured, status, kind, replacement_slug, parent_id, position,
        author, reason, session_id, at
      ) VALUES (
        ${id}::uuid, ${input.spaceId}::uuid, ${input.docId}::uuid, ${input.scope}, ${input.subject}, ${input.owner}::uuid,
        ${input.slug}, ${input.projectId}::uuid, ${input.op}, ${input.title}, ${input.body},
        ${input.delivery}, ${input.audiences}, ${input.featured ?? false}, ${input.status ?? 'current'}, ${input.kind ?? 'working'}, ${input.replacementSlug ?? null}, ${input.parentId}::uuid, ${input.position}, ${input.author}, ${input.reason}, ${input.sessionId}, ${input.at}::timestamptz
      )
    `
  }
  await tx`
    UPDATE doc SET latest_revision_id=${storedId}::uuid
    WHERE space_id=${input.spaceId}::uuid AND id=${input.docId}::uuid
  `
  return storedId
}
