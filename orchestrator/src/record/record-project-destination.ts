// concern: record-project-destination
/** Resolves a registered project's hosted-record destination without consulting hosted state. */

import type { RecordSpaceMembership } from '../../../shared/record-space-membership.ts'
import {
  type ProjectWriteSpaceRefusal,
  projectWriteSpace,
} from '../../../shared/record-write-space.ts'

export type ProjectRecordDestination =
  | { project: string; spaceId: string }
  | { project: string; refused: ProjectWriteSpaceRefusal; remedy: string }

/** Resolve a register declaration to a stable id without consulting the active space. */
export function projectRecordDestination(
  project: string,
  declaredSpace: string | null,
  memberships: readonly RecordSpaceMembership[],
): ProjectRecordDestination {
  return {
    project,
    ...projectWriteSpace(project, { declaredSpaces: { [project]: declaredSpace }, memberships }),
  }
}
