// concern: record-project-destination
/** Resolves a registered project's hosted-record destination without consulting hosted state. */

import {
  parseRecordSpaceMemberships,
  type RecordSpaceMembership,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import type { ProjectSettings, StoredProjectSettings } from '../project/project-settings.ts'
import type { RecordApiClient } from './record-api-client.ts'
import type { RecordIdentity } from './record-auth.ts'

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

export function projectDestinationFromIdentity(
  project: string,
  settings: ProjectSettings | StoredProjectSettings | undefined,
  identity: RecordIdentity,
): ProjectRecordDestination {
  if (!identity.activeSpaceId) {
    throw new Error('record session has no active space; run `orch record space switch <slug>`')
  }
  return projectRecordDestination(
    project,
    declaredRecordSpace(settings),
    identity.activeSpaceId,
    parseRecordSpaceMemberships(identity.memberships),
  )
}

export async function requireProjectRecordDestination(
  project: string,
  settings: ProjectSettings | StoredProjectSettings | undefined,
  client: RecordApiClient,
): Promise<string> {
  const decision = projectDestinationFromIdentity(project, settings, await client.whoami())
  if ('refused' in decision) {
    throw new Error(
      `project ${project} declares record space ${decision.declaredSpace}, but the signed-in user is not a member; join it first with an invitation, then retry`,
    )
  }
  return decision.spaceId
}
