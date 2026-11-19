// concern: hub-identity
/** Guards hosted hub natural-key uniqueness inside the caller's transaction. */

import type { SQL } from 'bun'

export async function hostedNoteIdentityByNumber(
  tx: SQL,
  spaceId: string,
  projectId: string,
  number: number,
): Promise<{ id: string; space_id: string } | null> {
  const rows = (await tx`SELECT id, space_id FROM hub_note
    WHERE space_id=${spaceId}::uuid AND project_id=${projectId}::uuid
    AND number=${number} FOR UPDATE`) as Array<{ id: string; space_id: string }>
  return rows[0] ?? null
}

export async function otherHostedTaskDocumentIdentityByNumber(
  tx: SQL,
  spaceId: string,
  taskId: string,
  number: number,
  recordId: string,
): Promise<string | null> {
  const rows = (await tx`SELECT id FROM hub_task_document
    WHERE space_id=${spaceId}::uuid AND task_id=${taskId}::uuid
    AND number=${number} AND id<>${recordId}::uuid`) as Array<{ id: string }>
  return rows[0]?.id ?? null
}
