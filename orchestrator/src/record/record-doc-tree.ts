// concern: record-doc-tree
/** Gathers hosted document tree facts for the pure document policy. */
import type { SQL } from 'bun'
import type { DocAudiences } from '../../../shared/docs.ts'
import { documentTreeWriteRefusal } from '../doc/doc-tree-rules.ts'

/** The live row at an address, else its most recently deleted one, locked for the write. */
export async function existingDocAtAddress(
  tx: SQL,
  spaceId: string,
  doc: { scope: string; subject: string | null; owner?: string | null; slug: string },
): Promise<Record<string, unknown> | undefined> {
  const rows = await tx`
    SELECT * FROM doc
    WHERE space_id=${spaceId}::uuid
      AND scope=${doc.scope}
      AND COALESCE(subject, '')=${doc.subject ?? ''}
      AND COALESCE(owner_user_id::text, '')=${doc.owner ?? ''}
      AND slug=${doc.slug}
    ORDER BY (deleted_at IS NULL) DESC, updated_at DESC, id DESC
    LIMIT 1
    FOR UPDATE
  `
  return rows[0] as Record<string, unknown> | undefined
}

export async function recordTreeWriteRefusal(
  tx: SQL,
  input: {
    spaceId: string
    id: string
    scope: string
    subject: string | null
    owner: string | null
    slug: string
    audiences: DocAudiences
    priorAudiences?: DocAudiences
    parentId: string | null
    parentWasSpecified: boolean
    removing?: boolean
  },
): Promise<string | null> {
  const parentRows = input.parentId
    ? await tx`SELECT * FROM doc WHERE space_id=${input.spaceId}::uuid AND id=${input.parentId}::uuid FOR UPDATE`
    : []
  const children =
    await tx`SELECT slug FROM doc WHERE space_id=${input.spaceId}::uuid AND parent_id=${input.id}::uuid AND deleted_at IS NULL`
  const ancestors = input.parentId
    ? await tx`
        WITH RECURSIVE ancestor AS (
          SELECT id,parent_id,slug FROM doc WHERE space_id=${input.spaceId}::uuid AND id=${input.parentId}::uuid
          UNION ALL
          SELECT d.id,d.parent_id,d.slug FROM doc d JOIN ancestor a ON d.id=a.parent_id
          WHERE d.space_id=${input.spaceId}::uuid
        ) SELECT slug FROM ancestor
      `
    : []
  return documentTreeWriteRefusal({
    slug: input.slug,
    scope: input.scope,
    subject: input.subject,
    owner: input.owner,
    audiences: input.audiences,
    priorAudiences: input.priorAudiences,
    parent: parentRows[0]
      ? {
          slug: String(parentRows[0].slug),
          scope: String(parentRows[0].scope),
          subject: parentRows[0].subject == null ? null : String(parentRows[0].subject),
          owner: parentRows[0].owner_user_id == null ? null : String(parentRows[0].owner_user_id),
          audiences: parentRows[0].audiences as DocAudiences,
          deleted: parentRows[0].deleted_at != null,
        }
      : null,
    requestedParentSlug: input.parentWasSpecified && input.parentId ? input.parentId : undefined,
    ancestorSlugs: ancestors.map((row: Record<string, unknown>) => String(row.slug)),
    children: children.map((row: Record<string, unknown>) => ({
      slug: String(row.slug),
    })),
    removing: input.removing,
  })
}

export function recordCanonTreeWriteRefusal(
  tx: SQL,
  input: {
    spaceId: string
    id: string
    subject: string | null
    owner: string | null
    slug: string
    prior: Record<string, unknown> | undefined
    removing?: boolean
  },
): Promise<string | null> {
  return recordTreeWriteRefusal(tx, {
    spaceId: input.spaceId,
    id: input.id,
    scope: 'canon',
    subject: input.subject,
    owner: input.owner,
    slug: input.slug,
    audiences: ['technical'],
    priorAudiences:
      input.prior?.audiences == null ? undefined : (input.prior.audiences as DocAudiences),
    parentId: input.prior?.parent_id == null ? null : String(input.prior.parent_id),
    parentWasSpecified: false,
    removing: input.removing,
  })
}
