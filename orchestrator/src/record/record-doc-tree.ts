// concern: record-doc-tree
/** Gathers hosted document tree facts for the pure document policy. */
import type { SQL } from 'bun'
import type { DocAudience } from '../../../shared/docs.ts'
import { documentTreeWriteRefusal } from '../doc/doc-tree-rules.ts'

export async function recordTreeWriteRefusal(
  tx: SQL,
  input: {
    spaceId: string
    id: string
    scope: string
    subject: string | null
    owner: string | null
    slug: string
    audience: DocAudience
    priorAudience?: DocAudience
    parentId: string | null
    parentWasSpecified: boolean
    removing?: boolean
  },
): Promise<string | null> {
  const parentRows = input.parentId
    ? await tx`SELECT * FROM doc WHERE space_id=${input.spaceId}::uuid AND id=${input.parentId}::uuid FOR UPDATE`
    : []
  const children =
    await tx`SELECT slug,audience FROM doc WHERE space_id=${input.spaceId}::uuid AND parent_id=${input.id}::uuid AND deleted_at IS NULL`
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
    audience: input.audience,
    priorAudience: input.priorAudience,
    parent: parentRows[0]
      ? {
          slug: String(parentRows[0].slug),
          scope: String(parentRows[0].scope),
          subject: parentRows[0].subject == null ? null : String(parentRows[0].subject),
          owner: parentRows[0].owner_user_id == null ? null : String(parentRows[0].owner_user_id),
          audience: String(parentRows[0].audience) as DocAudience,
          deleted: parentRows[0].deleted_at != null,
        }
      : null,
    requestedParentSlug: input.parentWasSpecified && input.parentId ? input.parentId : undefined,
    ancestorSlugs: ancestors.map((row: Record<string, unknown>) => String(row.slug)),
    children: children.map((row: Record<string, unknown>) => ({
      slug: String(row.slug),
      audience: String(row.audience) as DocAudience,
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
    audience: 'technical',
    priorAudience:
      input.prior?.audience == null ? undefined : (String(input.prior.audience) as DocAudience),
    parentId: input.prior?.parent_id == null ? null : String(input.prior.parent_id),
    parentWasSpecified: false,
    removing: input.removing,
  })
}
