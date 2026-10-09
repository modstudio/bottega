// concern: record-project-destination
/** Resolves a registered project's hosted-record destination without consulting hosted state. */

import {
  type RecordSpaceMembership,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import type { ProjectSettings, StoredProjectSettings } from '../project/project-settings.ts'

export type ProjectRecordDestination =
  | { project: string; spaceId: string }
  | { project: string; declaredSpace: string; refused: 'declared-space-not-member' }

export function declaredRecordSpace(
  settings: ProjectSettings | StoredProjectSettings | undefined,
): string | null {
  const value = settings?.space
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function effectiveProjectSpace(declared: string | null, activeSpaceId: string): string {
  return declared ?? activeSpaceId
}

/** Resolve a register declaration to a stable id, preserving active-space fallback. */
export function projectRecordDestination(
  project: string,
  declaredSpace: string | null,
  activeSpaceId: string,
  memberships: readonly RecordSpaceMembership[],
): ProjectRecordDestination {
  if (!declaredSpace) return { project, spaceId: effectiveProjectSpace(null, activeSpaceId) }
  const membership = recordSpaceMembership(declaredSpace, memberships)
  return membership
    ? { project, spaceId: membership.spaceId }
    : { project, declaredSpace, refused: 'declared-space-not-member' }
}

export function noActiveRecordSpaceRefusal(): string {
  return 'record session has no active space; run `orch record space switch <slug>`'
}

export function recordSpaceMembershipRefusal(space: string): string {
  return (
    `the signed-in user is not a member of record space ${space}; ` +
    `an invitation from a member of that space is needed; list invitations with ` +
    '`orch record space invitations`, then accept one with ' +
    '`orch record space accept <invitation-id>`'
  )
}
