// concern: record-question-destination
/** Resolves a question write to its registered project space or the user's personal space. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { recordWriteSpace } from '../../../shared/record-write-space.ts'
import { projectByRecordId, projectRowByRecordId } from '../project/project-read.ts'
import type { RecordWriteDestination } from './record-api-client-paths.ts'
import type { RecordIdentity } from './record-auth.ts'
import { requireProjectRecordDestination } from './record-project-destination-client.ts'

export class QuestionWriteIdentityError extends Error {}

type DestinationInput = {
  database: Database
  whoami: () => Promise<RecordIdentity>
}

export async function resolveQuestionWriteDestination(
  projectId: string | null,
  input: DestinationInput,
): Promise<RecordWriteDestination> {
  if (!projectId) {
    const identity = await input.whoami()
    const decision = recordWriteSpace(
      { kind: 'personal' },
      {
        declaredSpaces: {},
        personalSpaceId: identity.personalSpaceId,
        memberships: parseRecordSpaceMemberships(identity.memberships),
      },
    )
    if ('refused' in decision) throw new Error(decision.remedy)
    return { destinationSpaceId: decision.spaceId }
  }
  const project = projectByRecordId(projectId, input.database)
  if (!project) {
    const row = projectRowByRecordId(projectId, input.database)
    if (row?.retiredAt)
      throw new Error(
        `project ${row.name} is retired; un-retire it with \`${PLATFORM_SLUG} project retire ${row.name} --undo\`, then retry`,
      )
    throw new Error(`project ${projectId} is not registered; register it, then retry`)
  }
  return {
    destinationSpaceId: await requireProjectRecordDestination(project.name, project.settings, {
      whoami: input.whoami,
    }),
  }
}

export function questionWriteDestinations(input: DestinationInput) {
  let identityRead: Promise<RecordIdentity> | undefined
  const destinations = new Map<string | null, Promise<RecordWriteDestination>>()

  // A resolver is reused across calls, so a rejected read is forgotten rather
  // than replayed: the next call retries once the record answers again.
  const identity = () => {
    identityRead ??= input.whoami().catch((error: unknown) => {
      identityRead = undefined
      throw new QuestionWriteIdentityError(error instanceof Error ? error.message : String(error))
    })
    return identityRead
  }

  return (projectId: string | null): Promise<RecordWriteDestination> => {
    const cached = destinations.get(projectId)
    if (cached) return cached
    const result = resolveQuestionWriteDestination(projectId, {
      database: input.database,
      whoami: identity,
    }).catch((error: unknown) => {
      destinations.delete(projectId)
      throw error
    })
    destinations.set(projectId, result)
    return result
  }
}
