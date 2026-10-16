// concern: record-doc-order
/** Applies one validated hosted sibling order in its own tenant transaction. */

import { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { docOrderRefusal } from '../doc/doc-order.ts'
import { referenceOrderRefusal } from '../doc/doc-write-allowed.ts'
import { RecordDocError } from './record-doc-errors.ts'

export type RecordDocOrder = {
  spaceId: string
  scope: string
  subject: string | null
  parentId: string | null
  orderedIds: string[]
}

export async function reorderRecordDocRows(
  input: { url: string } & TenantPrincipal & RecordDocOrder,
): Promise<{ orderedIds: string[] }> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      if (input.parentId !== null) {
        const parents = await tx`
          SELECT form FROM doc
          WHERE space_id=${input.spaceId}::uuid AND id=${input.parentId}::uuid
        `
        const referenceRefusal = referenceOrderRefusal(
          parents[0]?.form == null ? null : String(parents[0].form),
        )
        if (referenceRefusal) throw new RecordDocError(referenceRefusal)
      }
      const rows = await tx`
        SELECT id FROM doc
        WHERE space_id=${input.spaceId}::uuid
          AND scope=${input.scope}
          AND COALESCE(subject, '')=${input.subject ?? ''}
          AND parent_id IS NOT DISTINCT FROM ${input.parentId}::uuid
          AND deleted_at IS NULL
        ORDER BY position, title, id
        FOR UPDATE
      `
      const refusal = docOrderRefusal(
        rows.map((row: Record<string, unknown>) => String(row.id)),
        input.orderedIds,
      )
      if (refusal) throw new RecordDocError(refusal)
      for (const [position, id] of input.orderedIds.entries()) {
        await tx`UPDATE doc SET position=${position} WHERE space_id=${input.spaceId}::uuid AND id=${id}::uuid`
      }
      return { orderedIds: input.orderedIds }
    })
  } finally {
    await client.close()
  }
}
