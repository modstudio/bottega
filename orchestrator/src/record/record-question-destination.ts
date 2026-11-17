// concern: record-question-destination
/** Resolves a question write to its registered project space or the user's personal space. */

import type { Database } from 'bun:sqlite'
import { projectByRecordId } from '../project/project-read.ts'
import type { RecordWriteDestination } from './record-api-client-paths.ts'
import type { RecordIdentity } from './record-auth.ts'
import { requireProjectRecordDestination } from './record-project-destination-client.ts'

export async function resolveQuestionWriteDestination(
  projectId: string | null,
  input: { database: Database; whoami: () => Promise<RecordIdentity> },
): Promise<RecordWriteDestination> {
  if (!projectId) {
    const identity = await input.whoami()
    if (!identity.personalSpaceId)
      throw new Error(
        'the signed-in user has no personal record space; repair record identity, then retry',
      )
    return { destinationSpaceId: identity.personalSpaceId }
  }
  const project = projectByRecordId(projectId, input.database)
  if (!project) throw new Error(`project ${projectId} is not registered; register it, then retry`)
  return {
    destinationSpaceId: await requireProjectRecordDestination(project.name, project.settings, {
      whoami: input.whoami,
    }),
  }
}
