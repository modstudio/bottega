// concern: record-doc-order
/** Applies one validated hosted sibling order inside its caller's tenant transaction. */

import type { SQL } from 'bun'
import { docOrderRefusal } from '../doc/doc-order.ts'
import { RecordDocError } from './record-doc-errors.ts'

export type RecordDocOrder = {
  spaceId: string
  scope: string
  subject: string | null
  parentId: string | null
  orderedIds: string[]
}

export async function reorderRecordDocRows(
  tx: SQL,
  input: RecordDocOrder,
): Promise<{ orderedIds: string[] }> {
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
}
