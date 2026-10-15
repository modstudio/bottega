// concern: record-project-identity
/** Resolves the hosted project identity while leaving route-specific retirement policy to callers. */
import type { SQL } from 'bun'

export type RecordProjectFacts = {
  id: string
  name: string
  spaceId: string
  retired: boolean
}

export type RecordProjectIdentityResult =
  | { status: 'found'; project: RecordProjectFacts; warnings: [] | ['name-mismatch'] }
  | { status: 'missing' | 'ambiguous' | 'outside-space'; warnings: [] }

export function recordProjectIdentityDecision(input: {
  requestedId?: string | null
  requestedName?: string | null
  requestedSpaceId?: string | null
  projects: RecordProjectFacts[]
}): RecordProjectIdentityResult {
  if (input.projects.length === 0) return { status: 'missing', warnings: [] }
  if (input.projects.length !== 1) return { status: 'ambiguous', warnings: [] }
  const project = input.projects[0]!
  if (input.requestedSpaceId && project.spaceId !== input.requestedSpaceId)
    return { status: 'outside-space', warnings: [] }
  return {
    status: 'found',
    project,
    warnings:
      input.requestedId && input.requestedName != null && input.requestedName !== project.name
        ? ['name-mismatch']
        : [],
  }
}

export async function resolveRecordProjectIdentity(
  tx: SQL,
  input: {
    projectId?: string | null
    projectName?: string | null
    spaceId?: string | null
    liveNameOnly?: boolean
  },
): Promise<RecordProjectIdentityResult> {
  const rows = input.projectId
    ? await tx`SELECT id,name,space_id,retired_at FROM project WHERE id=${input.projectId}::uuid`
    : input.spaceId
      ? await tx`SELECT id,name,space_id,retired_at FROM project
          WHERE space_id=${input.spaceId}::uuid AND name=${input.projectName}
            AND (${!input.liveNameOnly} OR retired_at IS NULL)`
      : await tx`SELECT id,name,space_id,retired_at FROM project
          WHERE name=${input.projectName} AND (${!input.liveNameOnly} OR retired_at IS NULL)`
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
