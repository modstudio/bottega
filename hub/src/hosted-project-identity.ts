// concern: hosted-project-identity
/** Hub SQL adapter over the shared project-identity decision. */
import type { SQL } from 'bun'
import {
  type RecordProjectIdentityResult,
  recordProjectIdentityDecision,
} from '../../shared/record-project-identity.ts'

export async function resolveHubRecordProjectIdentity(
  tx: SQL,
  input: {
    projectId?: string | null
    projectName?: string | null
    spaceId?: string | null
  },
): Promise<RecordProjectIdentityResult> {
  const rows = input.projectId
    ? await tx`SELECT id,name,space_id,retired_at FROM project WHERE id=${input.projectId}::uuid`
    : input.spaceId
      ? await tx`SELECT id,name,space_id,retired_at FROM project
          WHERE space_id=${input.spaceId}::uuid AND name=${input.projectName}`
      : await tx`SELECT id,name,space_id,retired_at FROM project WHERE name=${input.projectName}`
  const result = recordProjectIdentityDecision({
    requestedId: input.projectId,
    requestedName: input.projectName,
    requestedSpaceId: input.spaceId,
    projects: rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      name: String(row.name),
      spaceId: String(row.space_id),
      retired: row.retired_at != null,
    })),
  })
  if (result.status === 'found' && result.warnings.length > 0)
    console.warn(
      `record project identity mismatch: using id ${result.project.id} instead of name ${JSON.stringify(input.projectName)}`,
    )
  return result
}

export async function storedHubProjectId(
  tx: SQL,
  spaceId: string,
  input: { projectId?: string | null; projectName?: string | null },
): Promise<string | null> {
  if (!input.projectId && !input.projectName) return null
  const resolved = await resolveHubRecordProjectIdentity(tx, { ...input, spaceId })
  return resolved.status === 'found' ? resolved.project.id : null
}
