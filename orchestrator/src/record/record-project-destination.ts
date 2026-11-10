// concern: record-project-destination
/** Resolves a registered project's hosted-record destination without consulting hosted state. */

import {
  type RecordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import { recordWriteSpace } from '../../../shared/record-write-space.ts'

export type ProjectRecordDestination =
  | { project: string; spaceId: string }
  | { project: string; declaredSpace: string | null; refused: 'undeclared-project' | 'declared-space-not-member'; remedy: string }

/** Resolve a register declaration to a stable id without consulting the active space. */
export function projectRecordDestination(
  project: string,
  declaredSpace: string | null,
  memberships: readonly RecordSpaceMembership[],
): ProjectRecordDestination {
  const decision = recordWriteSpace(
    { kind: 'project', name: project },
    { declaredSpaces: { [project]: declaredSpace }, personalSpaceId: null, memberships },
  )
  return 'spaceId' in decision
    ? { project, spaceId: decision.spaceId }
    : { project, declaredSpace, refused: decision.refused as 'undeclared-project' | 'declared-space-not-member', remedy: decision.remedy }
}
