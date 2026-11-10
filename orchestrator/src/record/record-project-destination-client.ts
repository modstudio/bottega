// concern: record-project-destination-client
/** Adapts the pure project destination decision to authenticated record clients. */

import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { declaredRecordSpace } from '../project/declared-record-space.ts'
import type { ProjectSettings, StoredProjectSettings } from '../project/project-settings.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  type ProjectRecordDestination,
  projectRecordDestination,
} from './record-project-destination.ts'

export function projectDestinationFromIdentity(
  project: string,
  settings: ProjectSettings | StoredProjectSettings | undefined,
  identity: RecordIdentity,
): ProjectRecordDestination {
  return projectRecordDestination(
    project,
    declaredRecordSpace(settings),
    parseRecordSpaceMemberships(identity.memberships),
  )
}

export async function requireProjectRecordDestination(
  project: string,
  settings: ProjectSettings | StoredProjectSettings | undefined,
  client: { whoami(): Promise<RecordIdentity> },
): Promise<string> {
  const decision = projectDestinationFromIdentity(project, settings, await client.whoami())
  if ('refused' in decision) throw new Error(decision.remedy)
  return decision.spaceId
}
