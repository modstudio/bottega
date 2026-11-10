// concern: record-write-destination
/** Adapts a record write owner to an authorized hosted request destination. */

import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { type RecordWriteOwner, recordWriteSpace } from '../../../shared/record-write-space.ts'
import { declaredRecordSpace } from '../project/declared-record-space.ts'
import { projects } from '../project/projects.ts'
import { type RecordApiClient, RecordApiRequestError } from './record-api-client.ts'
import type { RecordRequestDestination } from './record-api-client-paths.ts'

export async function recordWriteDestination(
  client: RecordApiClient,
  owner: RecordWriteOwner | null,
): Promise<RecordRequestDestination> {
  const identity = await client.whoami()
  const registered = [...projects(), ...projects({ retired: true })]
  const decision = recordWriteSpace(owner, {
    declaredSpaces: Object.fromEntries(
      registered.map((project) => [project.name, declaredRecordSpace(project.settings)]),
    ),
    personalSpaceId: identity.personalSpaceId,
    memberships: parseRecordSpaceMemberships(identity.memberships),
  })
  if ('refused' in decision) throw new RecordApiRequestError(decision.remedy, 'refused', 409)
  return { destinationSpaceId: decision.spaceId }
}
