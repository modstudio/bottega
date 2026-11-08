// concern: record-project-space-refusal
/** Classifies and carries a hosted project id that belongs to another record space. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { postgresServerMessage, postgresSqlState } from '../../../shared/record/postgres-error.ts'
import { recordSpaceAccessDecision } from '../../../shared/record-space-request.ts'

const PROJECT_SPACE_CONFLICT_CODE = 'project_space_conflict'

export type ProjectSpaceConflict = {
  projectId: string
  projectName: string
  spaceId: string
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

export class RecordProjectWriteRefusalError extends Error {
  readonly status = 403

  constructor(spaceId: string) {
    const decision = recordSpaceAccessDecision('write', spaceId, [])
    if (decision.allowed) throw new Error('missing project write refusal')
    super(`${decision.error}; ${decision.remedy}`)
  }
}

function projectSpaceConflictMessage(
  conflict: ProjectSpaceConflict,
  requestSpace: string = conflict.spaceId,
): string {
  return `${projectSpaceConflictDiagnosis(conflict, requestSpace)}; ${projectSpaceConflictRemedy(conflict.projectName)}`
}

function projectSpaceConflictDiagnosis(
  conflict: ProjectSpaceConflict,
  requestSpace: string,
): string {
  return `project ${conflict.projectId} (${JSON.stringify(conflict.projectName)}) cannot be written to request space ${requestSpace}: this project id is already recorded under another space this request cannot write`
}

function projectSpaceConflictRemedy(projectName: string): string {
  return `set the project's declared space to the space that owns it with \`${PLATFORM_SLUG} project set ${projectName} --settings '{"space":"<owning-space-slug>"}'\`, or switch the active space with \`${PLATFORM_SLUG} record space switch <slug>\``
}

type ProjectWriteRefusalDecision = 'conflict' | 'read-only' | 'unchanged'

function projectWriteRefusalDecision(
  sqlState: string | null,
  table: string | null,
  hasWriteMembership: boolean,
): ProjectWriteRefusalDecision {
  if (sqlState !== '42501' || table !== 'project') return 'unchanged'
  return hasWriteMembership ? 'conflict' : 'read-only'
}

function postgresErrorTable(error: unknown): string | null {
  return (
    /for table (?:"([^"]+)"|([^\s]+))(?:\s|$)/
      .exec(postgresServerMessage(error))
      ?.slice(1)
      .find(Boolean) ?? null
  )
}

export function isProjectRowLevelSecurityViolation(error: unknown): boolean {
  return (
    projectWriteRefusalDecision(postgresSqlState(error), postgresErrorTable(error), true) ===
    'conflict'
  )
}

export function classifyProjectWriteRefusal(
  error: unknown,
  hasWriteMembership: boolean,
  conflict: ProjectSpaceConflict,
): RecordProjectSpaceConflictError | RecordProjectWriteRefusalError | null {
  const decision = projectWriteRefusalDecision(
    postgresSqlState(error),
    postgresErrorTable(error),
    hasWriteMembership,
  )
  if (decision === 'conflict') return new RecordProjectSpaceConflictError(conflict)
  if (decision === 'read-only') return new RecordProjectWriteRefusalError(conflict.spaceId)
  return null
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
