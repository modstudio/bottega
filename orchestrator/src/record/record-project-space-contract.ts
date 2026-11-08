// concern: record-project-space-contract
/** Carries a hosted project id that belongs to another record space. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'

const PROJECT_SPACE_CONFLICT_CODE = 'project_space_conflict'

export type ProjectSpaceConflict = {
  projectId: string
  projectName: string
  spaceId: string
}

function projectSpaceConflictMessage(
  conflict: ProjectSpaceConflict,
  requestSpace: string = conflict.spaceId,
): string {
  return renderRefusal(
    refusal(
      `project ${conflict.projectId} (${JSON.stringify(conflict.projectName)}) cannot be written to request space ${requestSpace}: this project id is already recorded under another space this request cannot write; alternatively switch the active space with ${PLATFORM_SLUG} record space switch <slug>`,
      {
        kind: 'command',
        argv: [
          PLATFORM_SLUG,
          'project',
          'set',
          conflict.projectName,
          '--settings',
          `'{"space":"<owning-space-slug>"}'`,
        ],
      },
    ),
  )
}

export class RecordProjectSpaceConflictError extends Error {
  readonly status = 409
  readonly code = PROJECT_SPACE_CONFLICT_CODE
  readonly projectId: string
  readonly projectName: string
  readonly spaceId: string

  constructor(conflict: ProjectSpaceConflict) {
    super(projectSpaceConflictMessage(conflict))
    this.projectId = conflict.projectId
    this.projectName = conflict.projectName
    this.spaceId = conflict.spaceId
  }

  messageForRequestSpace(requestSpace: string = this.spaceId): string {
    return projectSpaceConflictMessage(this, requestSpace)
  }
}

export function projectSpaceConflictResponse(error: RecordProjectSpaceConflictError) {
  return {
    code: error.code,
    error: error.message,
    projectId: error.projectId,
    projectName: error.projectName,
    spaceId: error.spaceId,
  }
}

export function parseProjectSpaceConflictResponse(
  body: unknown,
  status: number,
): RecordProjectSpaceConflictError | null {
  if (status !== 409 || body === null || typeof body !== 'object') return null
  const row = body as Record<string, unknown>
  if (
    row.code !== PROJECT_SPACE_CONFLICT_CODE ||
    typeof row.projectId !== 'string' ||
    typeof row.projectName !== 'string' ||
    typeof row.spaceId !== 'string'
  )
    return null
  return new RecordProjectSpaceConflictError({
    projectId: row.projectId,
    projectName: row.projectName,
    spaceId: row.spaceId,
  })
}
