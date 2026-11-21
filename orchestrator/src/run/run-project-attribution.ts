// concern: run project attribution
/** Validates explicit row-only attribution separately from the run's project selector. */

import { projectByName, projectByRecordId } from '../project/projects.ts'

export function runProjectAttribution(input: {
  projectName: string | null
  projectRecordId?: string
}): { namedProjectRecordId: string | null; runProjectRecordId: string | null } {
  if (input.projectRecordId && !projectByRecordId(input.projectRecordId)) {
    throw new Error(`unknown project record ${JSON.stringify(input.projectRecordId)}`)
  }
  const namedProjectRecordId = input.projectName
    ? (projectByName(input.projectName)?.recordId ?? null)
    : null
  return {
    namedProjectRecordId,
    runProjectRecordId: input.projectRecordId ?? namedProjectRecordId,
  }
}
