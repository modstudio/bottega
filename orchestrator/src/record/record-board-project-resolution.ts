// concern: record-board-project-resolution
/** Resolves visible hosted board projects without exposing tenant queries to board operations. */

import type { SQL } from 'bun'
import { MISSING_PROJECT_ID_REMEDY } from '../../../shared/record-project-identity.ts'
import { RecordBoardError } from './record-board-contract.ts'
import { resolveRecordProjectIdentity } from './record-project-identity.ts'

export async function resolveVisibleProjectId(
  tx: SQL,
  name: string,
  requestedId?: string | null,
): Promise<string> {
  if (!requestedId)
    throw new RecordBoardError(
      `project-scoped board write is missing projectId; ${MISSING_PROJECT_ID_REMEDY}`,
      400,
    )
  const resolved = await resolveRecordProjectIdentity(tx, {
    projectId: requestedId,
    projectName: name,
  })
  if (resolved.status !== 'found' || resolved.project.retired)
    throw new RecordBoardError(`unknown or invisible board project ${name}`, 400)
  return resolved.project.id
}

export async function resolvePostingProjectId(
  tx: SQL,
  name: string,
  requestedId?: string | null,
): Promise<string | null> {
  if (!requestedId)
    throw new RecordBoardError(
      `project-scoped board write is missing projectId; ${MISSING_PROJECT_ID_REMEDY}`,
      400,
    )
  const resolved = await resolveRecordProjectIdentity(tx, {
    projectId: requestedId,
    projectName: name,
  })
  if (resolved.status !== 'found')
    throw new RecordBoardError(`unknown or invisible board project ${name}`, 400)
  return resolved.project.retired ? null : resolved.project.id
}

export async function resolvePostProjects(
  tx: SQL,
  projectName: string | null,
  postingProject: string | undefined,
  postingProjectId: string | null | undefined,
): Promise<{ projectId: string | null; authorProjectId: string | null }> {
  const projectId = projectName
    ? await resolveVisibleProjectId(tx, projectName, postingProjectId)
    : null
  if (!postingProject) return { projectId, authorProjectId: null }
  if (projectName === postingProject) return { projectId, authorProjectId: projectId }
  const authorProjectId = await resolvePostingProjectId(tx, postingProject, postingProjectId)
  return { projectId, authorProjectId }
}
