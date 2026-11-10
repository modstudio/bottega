// concern: hosted record sequences
/** Allocates one project-scoped hosted record sequence number under a row lock. */
import type { SQL } from 'bun'
import { newRecordId } from '../../../shared/record-id.ts'

export async function allocateRecordSequence(
  tx: SQL,
  spaceId: string,
  projectId: string,
  name: string,
): Promise<number> {
  await tx`INSERT INTO seq(id,space_id,project_id,name,next)
    VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${projectId}::uuid,${name},1)
    ON CONFLICT(space_id,project_id,name) DO NOTHING`
  const rows = (await tx`SELECT next::text FROM seq WHERE space_id=${spaceId}::uuid
    AND project_id=${projectId}::uuid AND name=${name} FOR UPDATE`) as Array<{ next: string }>
  const number = Number(rows[0]!.next)
  await tx`UPDATE seq SET next=${number + 1} WHERE space_id=${spaceId}::uuid
    AND project_id=${projectId}::uuid AND name=${name}`
  return number
}
