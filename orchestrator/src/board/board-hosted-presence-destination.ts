// concern: hosted-board-presence-destination
/** Names the hosted space that owns this checkout session's presence. */

import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { recordWriteSpace } from '../../../shared/record-write-space.ts'
import { declaredRecordSpace } from '../project/declared-record-space.ts'
import { projectAt, projects } from '../project/projects.ts'
import { type RecordApiClient, RecordApiRequestError } from '../record/record-api-client.ts'
import type { RecordRequestDestination } from '../record/record-api-client-paths.ts'

async function writeFacts(client: RecordApiClient) {
  const identity = await client.whoami()
  const registered = [...projects(), ...projects({ retired: true })]
  return {
    declaredSpaces: Object.fromEntries(
      registered.map((project) => [project.name, declaredRecordSpace(project.settings)]),
    ),
    personalSpaceId: identity.personalSpaceId,
    memberships: parseRecordSpaceMemberships(identity.memberships),
  }
}

function destination(decision: ReturnType<typeof recordWriteSpace>): RecordRequestDestination {
  if ('refused' in decision) throw new RecordApiRequestError(decision.remedy, 'refused', 409)
  return { destinationSpaceId: decision.spaceId }
}

/** Names the space for a board write, using its project when it carries one. */
export async function boardWriteDestination(
  client: RecordApiClient,
  project?: string | null,
): Promise<RecordRequestDestination> {
  return destination(
    recordWriteSpace(
      project ? { kind: 'project', name: project } : { kind: 'personal' },
      await writeFacts(client),
    ),
  )
}

export async function boardPresenceDestination(
  client: RecordApiClient,
  cwd: string = process.cwd(),
) {
  return destination(
    recordWriteSpace(
      { kind: 'session', checkoutProject: projectAt(cwd)?.name ?? null },
      await writeFacts(client),
    ),
  )
}
