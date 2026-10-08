/** Writes one normalized hosted document import. Must not know validation or transaction ownership. */
import type { SQL } from 'bun'
import type { NormalizedRecordDocImport } from './record-doc-mapping.ts'

export async function writeImportedRecordDoc(
  tx: SQL,
  input: {
    spaceId: string
    id: string
    exists: boolean
    projectId: string | null
    doc: NormalizedRecordDocImport['doc']
  },
): Promise<void> {
  const { doc, spaceId, id, projectId } = input
  if (input.exists) {
    await tx`
      UPDATE doc
      SET title=${doc.title}, body=${doc.body}, delivery=${doc.delivery},
          audience=${doc.audience}, featured=${doc.featured}, status=${doc.status}, kind=${doc.kind}, replacement_slug=${doc.replacementSlug}, parent_id=${doc.parentId}::uuid, position=${doc.position},
          owner_user_id=${doc.owner ?? null}::uuid, project_id=${projectId}::uuid,
          created_at=${doc.createdAt}::timestamptz,
          updated_at=${doc.updatedAt}::timestamptz,
          deleted_at=${doc.deletedAt}::timestamptz
      WHERE id=${id}::uuid AND space_id=${spaceId}::uuid
    `
    return
  }
  await tx`
    INSERT INTO doc (
      id, space_id, scope, subject, owner_user_id, slug, title, body, delivery, audience, featured, status, kind, replacement_slug, parent_id, position, project_id,
      created_at, updated_at, deleted_at
    ) VALUES (
      ${id}::uuid, ${spaceId}::uuid, ${doc.scope}, ${doc.subject}, ${doc.owner ?? null}::uuid, ${doc.slug},
      ${doc.title}, ${doc.body}, ${doc.delivery}, ${doc.audience}, ${doc.featured}, ${doc.status}, ${doc.kind}, ${doc.replacementSlug}, ${doc.parentId}::uuid, ${doc.position}, ${projectId}::uuid,
      ${doc.createdAt}::timestamptz, ${doc.updatedAt}::timestamptz, ${doc.deletedAt}::timestamptz
    )
  `
}
