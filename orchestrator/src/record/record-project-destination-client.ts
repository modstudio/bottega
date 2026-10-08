// concern: record-project-destination-client
/** Adapts the pure project destination decision to authenticated record clients. */

import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import type { ProjectSettings, StoredProjectSettings } from '../project/project-settings.ts'
import type { RecordApiClient } from './record-api-client.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  declaredRecordSpace,
  noActiveRecordSpaceRefusal,
  type ProjectRecordDestination,
  projectRecordDestination,
  recordSpaceMembershipRefusal,
} from './record-project-destination.ts'

export function projectDestinationFromIdentity(
  project: string,
  settings: ProjectSettings | StoredProjectSettings | undefined,
  identity: RecordIdentity,
): ProjectRecordDestination {
  if (!identity.activeSpaceId) throw new Error(noActiveRecordSpaceRefusal())
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
  if ('refused' in decision) throw new Error(recordSpaceMembershipRefusal(decision.declaredSpace))
  return decision.spaceId
}
