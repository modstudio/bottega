// concern: run project attribution
/** Validates explicit row-only attribution separately from the run's project selector. */

import { projectByName, projectByRecordId } from '../project/projects.ts'
import type { RunProjectAttribution } from './run-claim-types.ts'

function validateRunProjectRecordId(projectRecordId?: string): void {
  if (projectRecordId && !projectByRecordId(projectRecordId)) {
    throw new Error(
      `unknown project record ${JSON.stringify(projectRecordId)}; replace it with a registered project's record id from project list --json`,
    )
  }
}

export function runProjectAttribution(
  projectName: string | null,
  projectRecordId?: string,
): RunProjectAttribution {
  validateRunProjectRecordId(projectRecordId)
  const namedProjectRecordId = projectName ? (projectByName(projectName)?.recordId ?? null) : null
  return {
    namedProjectRecordId,
    rowProjectId: (derivedProjectRecordId) =>
      projectRecordId ?? derivedProjectRecordId ?? namedProjectRecordId,
  }
}
