// concern: hosted-board-presence-destination
/** Names the hosted space that owns this checkout session's presence. */

import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { recordWriteSpace } from '../../../shared/record-write-space.ts'
import { declaredRecordSpace } from '../project/declared-record-space.ts'
import { projectAt, projects } from '../project/projects.ts'
import { type RecordApiClient, RecordApiRequestError } from '../record/record-api-client.ts'

export async function boardPresenceDestination(
  client: RecordApiClient,
  cwd: string = process.cwd(),
) {
  const identity = await client.whoami()
  const registered = [...projects(), ...projects({ retired: true })]
  const decision = recordWriteSpace(
    { kind: 'session', checkoutProject: projectAt(cwd)?.name ?? null },
    {
      declaredSpaces: Object.fromEntries(
        registered.map((project) => [project.name, declaredRecordSpace(project.settings)]),
      ),
      personalSpaceId: identity.personalSpaceId,
      memberships: parseRecordSpaceMemberships(identity.memberships),
    },
  )
  if ('refused' in decision) throw new RecordApiRequestError(decision.remedy, 'refused', 409)
  return { destinationSpaceId: decision.spaceId }
}
