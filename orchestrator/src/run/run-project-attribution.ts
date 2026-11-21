// concern: run project attribution
/** Validates explicit row-only attribution separately from the run's project selector. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { projectByName, projectByRecordId } from '../project/projects.ts'

export function validateRunProjectRecordId(projectRecordId?: string): void {
  if (projectRecordId && !projectByRecordId(projectRecordId)) {
    throw new Error(
      `unknown project record ${JSON.stringify(projectRecordId)}; pass a registered project's record id (${PLATFORM_SLUG} project list --json)`,
    )
  }
}

export function runProjectAttribution(
  projectName: string | null,
  projectRecordId?: string,
): {
  namedProjectRecordId: string | null
  rowProjectId(derivedProjectRecordId?: string | null): string | null
} {
  validateRunProjectRecordId(projectRecordId)
  const namedProjectRecordId = projectName ? (projectByName(projectName)?.recordId ?? null) : null
  return {
    namedProjectRecordId,
    rowProjectId: (derivedProjectRecordId) =>
      projectRecordId ?? derivedProjectRecordId ?? namedProjectRecordId,
  }
}
