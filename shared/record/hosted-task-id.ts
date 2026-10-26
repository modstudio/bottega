// concern: hosted-task-id
/** Resolves an optional hosted task reference inside one space. */
import type { SQL } from 'bun'

export async function hostedTaskIdForReference(
  tx: SQL,
  spaceId: string,
  reference: {
    id?: string | null
    key?: string | null
    project?: string | null
  },
): Promise<string | null> {
  if (reference.id) {
    const byId = await tx<{ id: string }[]>`SELECT id::text AS id FROM hub_task
      WHERE space_id=${spaceId}::uuid AND id=${reference.id}::uuid`
    if (byId[0]) return byId[0].id
  }
  if (!reference.key) return null
  const byKey = await tx<{ id: string }[]>`SELECT id::text AS id FROM hub_task
    WHERE space_id=${spaceId}::uuid AND key=${reference.key} AND deleted_at IS NULL
      AND (${reference.project}::text IS NULL OR project_name=${reference.project})
    LIMIT 2`
  return byKey.length === 1 ? byKey[0]!.id : null
}
